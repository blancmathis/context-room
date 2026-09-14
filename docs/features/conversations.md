---
context_room:
  id: product.conversations
  depends_on: [product.document-workflow, system.connected-devices, assurance.review.human-authority]
---

# Original-source conversations

## Summary

Discuss a document or notebook through the optional Codex connection. The
conversation retains its original source while other documents remain usable.
Dictation produces a local draft for review before sending. The Android owner
preview also supports native microphone capture and exact-answer playback.

## Defines

Original source selection, saved conversations and composer drafts, scoped
agent actions, explicit task recovery and foreground audio in the current preview.

## Does not define

Automatic documentary acceptance, continuous hands-free voice, physical BOOX
performance, a standalone tablet agent, or a new notes application.

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
Model installation and continuous voice are still convergence work.

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
starts dictation. It captures bounded PCM privately, closes the microphone on
backgrounding and retains unacknowledged recordings with their original source.
**Recover dictation** restores one for an explicit transcription retry. Its audio
is removed only after the composer draft is saved. The bridge is restricted to
the trusted main frame; document frames cannot request microphone or file access.
Drawing-only pairings do not receive conversation or owner permissions.

Completed desktop recordings also remain in the saved composer draft when
transcription needs retry. Recovery of an unfinished browser recording is not
implemented yet. See the [convergence verification](../lifecycle/changes/active/android-convergence/verification.md)
for exact browser, provider, emulator and remaining physical proof boundaries.
