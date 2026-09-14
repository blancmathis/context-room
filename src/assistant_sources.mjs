import { TextDecoder } from 'node:util';
import { notebookHash, canonicalNotebookRoot, readNotebookBytes } from './notebook_io.mjs';
import { readNotebook } from './notebooks.mjs';
import { NotebookAgentContext, NOTEBOOK_AGENT_TOOL } from './notebook_agent.mjs';

const fault = (code, message, statusCode = 409) => Object.assign(new Error(message), { code, statusCode });
const DOCUMENT_TOOL = { type: 'function', name: 'context_room_document',
  description: 'Read a bounded passage of the original document, or propose its complete replacement for human review. Propose requires the current content hash. No other file, acceptance, publication or permission operation is available.',
  inputSchema: { type: 'object', additionalProperties: false, required: ['action'], properties: {
    action: { type: 'string', enum: ['read', 'propose'] }, offset: { type: 'integer', minimum: 0 },
    limit: { type: 'integer', minimum: 1, maximum: 32000 }, expectedHash: { type: 'string' },
    content: { type: 'string', maxLength: 200000 }, title: { type: 'string', maxLength: 160 },
  } } };

/** The original source is stored privately once; authorization is checked again on every use. */
export function createAssistantSourceResolver({ canRead, canWrite, proposeDocument }) {
  return (root, input, origin = {}) => {
    if (!input || !['notebook', 'document'].includes(input.kind) || typeof input.path !== 'string'
      || !canRead(root, input.path, input.kind)) throw fault('assistant_source_scope', 'Select a document or notebook in this project’s allowed scope.', 403);
    const rootIdentity = canonicalNotebookRoot(root);
    let source = structuredClone(input);
    const permitted = () => {
      if (canonicalNotebookRoot(root) !== rootIdentity || !canRead(root, source.path, source.kind)) throw fault('assistant_source_scope', 'The original source is no longer authorized.', 403);
    };
    const document = () => {
      permitted(); const bytes = readNotebookBytes(root, source.path, 1024 * 1024);
      if (!bytes) throw fault('assistant_source_missing', 'The original document is unavailable. Its conversation is preserved.');
      let content; try { content = new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
      catch { throw fault('assistant_document_format', 'Choose a UTF-8 Markdown, HTML or text document.', 400); }
      return { content, hash: notebookHash(bytes) };
    };
    const notebook = () => {
      permitted(); const scene = readNotebook(root, source.resourceId);
      if (scene.locator.path !== source.path || scene.locator.revision !== source.locationRevision) throw fault('assistant_source_moved', 'The original notebook moved. The conversation remains linked to its recorded location.');
      return scene;
    };
    if (origin.creating) {
      const keys = source.kind === 'notebook' ? ['kind', 'path', 'resourceId', 'revision', 'locationRevision', 'selection'] : ['kind', 'path', 'hash', 'selection'];
      if (Object.keys(source).some(key => !keys.includes(key))) throw fault('assistant_source_invalid', 'Unsupported source context.', 400);
      if (source.kind === 'notebook') {
        const scene = notebook();
        if (source.revision !== scene.revision) throw fault('assistant_source_changed', 'The notebook changed. Refresh it before starting the conversation.');
        if (!Array.isArray(source.selection) || source.selection.length > 64 || new Set(source.selection).size !== source.selection.length) throw fault('assistant_selection', 'Select at most 64 distinct notebook objects.', 400);
        const selected = source.selection.map(id => scene.document.objects.find(object => object.id === id));
        if (selected.some(object => !object)) throw fault('assistant_selection', 'The original selection changed before the conversation started.');
        source.original = { revision: scene.revision, title: scene.document.title,
          selection: selected.map(object => ({ id: object.id, type: object.type, revision: object.revision, ...(object.type === 'text' ? { text: object.text.slice(0, 4000) } : {}) })) };
      } else {
        if (!/\.(?:md|markdown|txt|html?)$/i.test(source.path)) throw fault('assistant_document_format', 'Choose a Markdown, HTML or text document.', 400);
        const file = document();
        if (source.hash && source.hash !== file.hash) throw fault('assistant_source_changed', 'The original document changed before the conversation started.');
        let excerpt = file.content.slice(0, 12000);
        if (source.selection) {
          const { start, end, text } = source.selection;
          if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start || end - start > 12000 || file.content.slice(start, end) !== text) throw fault('assistant_selection', 'The selected passage no longer matches the original document.');
          excerpt = text;
        }
        source.hash = file.hash; source.original = { hash: file.hash, excerpt, length: file.content.length };
      }
      if (JSON.stringify(source).length > 24000) throw fault('assistant_context_limit', 'Choose a smaller original selection.', 400);
    }
    const baseContext = () => ({ source: { ...source, project: 'original exact project' }, working: true, accepted: false,
      instructions: 'The original selection is a recorded reference. Read current revisions before acting. Navigation does not retarget this conversation.' });
    if (source.kind === 'notebook') return { source, title: source.original?.title || source.path, tools: [NOTEBOOK_AGENT_TOOL],
      context: () => { const scene = notebook(); return { ...baseContext(), currentRevision: scene.revision, totalObjects: scene.document.objects.length,
        page: scene.document.page, missingSelectedObjects: source.selection.filter(id => !scene.document.objects.some(object => object.id === id)) }; },
      call: (name, input, options) => {
        notebook();
        // Deleted selected objects remain in the recorded source; reading the current scene still works.
        const agent = new NotebookAgentContext({ root, resourceId: source.resourceId, locationRevision: source.locationRevision,
          sessionId: origin.sessionId, selection: [], canRead: rel => canRead(root, rel, 'notebook'), canWrite: rel => canWrite(root, rel, 'notebook') });
        agent.selection = source.selection; agent.originalRevision = source.revision;
        return agent.call(name, input, options);
      } };
    return { source, title: source.path, tools: [DOCUMENT_TOOL], context: () => ({ ...baseContext(), currentHash: document().hash }),
      call: async (name, input, { signal, callId, turnId } = {}) => {
        signal?.throwIfAborted();
        if (name !== DOCUMENT_TOOL.name || !input || Object.keys(input).some(key => !['action', 'offset', 'limit', 'content', 'expectedHash', 'title'].includes(key))) throw fault('assistant_tool_scope', 'Use only the original document tool.', 403);
        const current = document();
        if (input.action === 'read') {
          const offset = input.offset ?? 0, limit = input.limit ?? 12000;
          if (!Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 32000) throw fault('assistant_document_page', 'Read a bounded document passage.', 400);
          return { path: source.path, hash: current.hash, content: current.content.slice(offset, offset + limit), offset, totalLength: current.content.length, accepted: false };
        }
        if (input.action !== 'propose' || !proposeDocument || !canWrite(root, source.path, 'document')) throw fault('assistant_proposal_scope', 'This original document is not editable through a proposal.', 403);
        if (input.expectedHash !== current.hash) throw fault('assistant_document_conflict', 'The original document changed. Read it again before proposing an edit.');
        if (typeof input.content !== 'string' || input.content.length > 200000 || typeof callId !== 'string' || !callId || typeof turnId !== 'string' || !turnId) throw fault('assistant_document_edit', 'A bounded replacement and exact tool call are required.', 400);
        signal?.throwIfAborted();
        return proposeDocument(root, { path: source.path, expectedHash: current.hash, content: input.content,
          title: typeof input.title === 'string' ? input.title.slice(0, 160) : 'Conversation edit',
          requestId: 'assistant-' + notebookHash({ sessionId: origin.sessionId, turnId, callId }), signal });
      } };
  };
}
