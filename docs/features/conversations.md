---
context_room:
  id: product.conversations
  depends_on: [product.document-workflow, system.connected-devices, assurance.review.human-authority]
---

# Original-source conversations

## Summary

Discuss a document or notebook through the optional Codex connection. The
conversation retains its original source while other documents remain usable.
Dictation produces a local draft for review before sending. Explicit Voice
cycles between listening, the original agent and spoken answers. The Android
owner preview uses native microphone capture and exact-answer playback.

## Defines

Original source selection, saved conversations and composer drafts, scoped
agent actions, explicit task recovery and foreground audio in the current preview.

## Does not define

Automatic documentary acceptance, physical BOOX performance, acoustic interruption
during speaker playback, a standalone tablet agent, or a new notes application.

## Open and resume

Use **Discuss** or **Dictate** beside a saved Markdown, text or HTML document,
or **Ask about selection** in a notebook. Save local edits and resolve external
conflicts first. A document's current disk version can be discussed during its
human review; this does not accept it. Frozen proposal review remains separate.

The panel names its original file. Changing the visible project or document
does not change that source, its captured selection or its Codex task. Reopening
the same source resumes its latest matching conversation. **New conversation**
starts a separate one; the history selector retains earlier conversations.
Composer text and an unconfirmed send identity remain in the current browser's
private IndexedDB. They are restored with that conversation after reload.

The model catalog is loaded only after an explicit connection action. Reading,
drawing, `doctor`, `guard` and `brief` do not require an agent. The adapter starts
its own local stdio Codex process; it never restarts Desktop. Model tools remain
bound to the original file or notebook. Arbitrary shell, network, other project
files, acceptance, rejection and publication are not exposed through this adapter.

Notebook edits appear as working objects with provenance and checked revisions.
Progressive strokes save only their reached geometry. Document edits use the
existing isolated local proposal workflow. **Stop agent** stops the original
turn and preserves already recorded ink. An uncertain send is not replayed:
**Inspect original task** verifies its exact turn and input before recovering
an answer when the provider can supply that evidence.

## Dictation and playback

Choose **Dictate**, then **Finish dictation**. A visible indicator distinguishes
capture, local transcription and stopped audio. The resulting text remains in
the composer until **Send** is pressed. Silence does not generate a message.
Recognition uses a local `whisper-cli` installation and model on the Mac;
`CONTEXT_ROOM_WHISPER_MODEL` can point to a separately installed model file.
Model installation remains convergence work.

**Voice** explicitly enables sending recognized phrases to this conversation.
It requires a clear composer, keeps the transcript in the original history and
returns to listening after the answer is played. While the agent thinks or
draws, a new spoken phrase stops that exact turn before sending its replacement.
During playback the microphone is off; **Interrupt and speak** stops the answer
and returns to listening. **End voice** stops its microphone, playback and active
voice turn. Returning from the background never restarts Voice automatically.
Recognition or network failure stops the loop and retains recoverable input.

**Read answer** prepares exact passages from the recorded answer with local
macOS speech and plays them on the active surface. A prepared passage is not
reported as played until playback completes. **Stop audio**, loss of the audio
controller, closing the page or backgrounding interrupts it. The microphone
and answer playback do not run together in this preview.

Only one surface owns the expiring audio controller. **Take over audio** is an
explicit action; stale responses and epochs cannot restart or acknowledge a
different operation. Changing the conversation is disabled during capture,
transcription and playback.

The Android owner preview requests microphone permission only after the user
starts dictation or Voice. It captures bounded PCM privately, closes the microphone on
backgrounding and retains unacknowledged recordings with their original source.
**Recover dictation** restores one for an explicit transcription retry. Its audio
is removed only after the composer draft is saved, or an explicit **Discard dictation**.
The bridge is restricted to
the trusted main frame; document frames cannot request microphone or file access.
Drawing-only pairings do not receive conversation or owner permissions.

In the native notebook, **Conversation** opens the same original-source panel
beside the pen on wide screens, or below it on smaller screens. Voice and native
writing can run together. The original selection is captured when opening the
conversation. Agent progress shows a tip only on geometry already received by
the native canvas; completed, expired or moved geometry cannot leave a live tip.
Closing the panel stops its audio. Returning to the owner workspace retains its
notebook dialog, working scene and conversation draft. An active conversation,
microphone or unsent draft defers remote notebook navigation.

Desktop capture journals microphone chunks in private IndexedDB every half second.
After reload, **Recover dictation** restores the saved chunks in their original
conversation; the last uncommitted fraction cannot be guaranteed after a crash.
A storage failure stops capture and preserves the earlier committed chunks.
Neither recovery nor dictation starts the agent automatically. Completed recordings
also remain with the composer when transcription needs retry. Controls wait for
the original draft and history to finish loading before permitting a new capture.
A microphone stop that cannot reach the Mac is retained with its exact controller
identity and released on return; it cannot stop a newer audio controller.
Earlier previews' equivalent local-root scope keys remain recoverable. This
compatibility is limited to that exact root; it does not combine worktrees,
projects or review scopes, or resurrect an explicitly cleared composer draft.
The current browser, provider, emulator and remaining physical
proof boundaries are in `docs/lifecycle/changes/active/android-convergence/verification.md`
in the Context Room source repository.
