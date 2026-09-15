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

Use **Discuss**, **Dictate** or **Voice** beside a Markdown, text or HTML document,
or the notebook's conversation controls. Discuss and Voice require saved local
edits; dictation can enrich an existing editable draft. Resolve external
conflicts first. A document's current disk version can be discussed during its
human review; this does not accept it. Frozen proposal review remains separate.

The panel names its original file. Changing the visible project or document
does not change that source, its captured selection or its Codex task. Reopening
the same source resumes its latest matching conversation. **New conversation**
starts a separate one; the history selector retains earlier conversations.
**Load older conversations** continues beyond the first 50 entries. History
filters by the original project, file and notebook location before paging;
conversations in other files cannot hide the matching conversation. If the
saved list changes, **Refresh history** reloads it while keeping the selected
conversation and its unsent text. Neither action starts Codex or sends a message.
Inactive tasks can leave the provider's bounded memory cache. Reopening them
resumes their saved original Codex identity and history. An active turn, a task
being prepared or inspected, or an uncertain outcome cannot be unloaded to
make room for another conversation.
Composer text and an unconfirmed send identity remain in the current browser's
private IndexedDB. They are restored with that conversation after reload.

## Recovered Lisière history

The [recovery CLI](../system/lisiere-migration.md#import-a-retained-conversation)
can link a retained conversation to a chosen document or working notebook.
**Read retained messages** shows the original text, context and partial answers.
**Export original history** keeps the exact source records, including events
that have no readable projection. Long messages and exports use bounded pages;
an interrupted or cancelled export leaves the private original available.

The original task identity remains recorded. Sending a new message or starting
Voice explicitly creates a separate Context Room task for the selected source.
It can read the retained messages through a scoped history tool. Original
contexts, approvals and uncertain requests are historical data; they do not
expand its permission or get replayed. Later Context Room messages resume this
new task through the usual saved-conversation workflow.

Legacy Desktop bindings may contain only an identity and retained requests in
the snapshot. The interface does not invent missing messages or claim an old
request was delivered. The original task remains in Codex.

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

## Sharing the current source with Codex

In the expanded conversation, **Share live source** explicitly shares the original document draft or the
visible notebook area. It starts off and never captures the rest of the screen.
The notebook image includes an unfinished gesture, the viewport and up to 64
selected objects. A document supplies a bounded draft excerpt around its text
selection. These previews remain working context, separate from saved content
and human acceptance.

Codex receives the current preview when it reads the original source using its
existing document or notebook tool. The indicator shows when that read occurs;
sharing does not itself start a turn. **Stop sharing source** remains in the
conversation header, including while minimized. Another surface must explicitly
choose **Take over source sharing**. Navigating to another document pauses its
preview; closing the notebook, leaving the foreground, closing the conversation
or switching to direct dictation stops this surface's sharing. Reload does not
restart it.

The Mac holds at most eight active previews in memory. They expire after five
seconds without renewal. Images are limited to 1024 pixels per side and one MiB;
document excerpts to 20,000 characters. Each frame rechecks the original project,
source and sharing controller. No preview file is written to the project.
An image or passage already read by Codex can remain in its conversation
history; stopping sharing prevents new reads and does not erase prior context.

Android owner conversations capture only the visible native drawing area.
Compression runs outside the UI thread. A document frame or restricted drawing
connection cannot use the owner preview bridge.

## Dictation and playback

Choose the source's **Dictate** control to start capture directly in a compact
panel, then **Finish dictation**. **Open conversation** expands the same session.
A visible indicator distinguishes capture, local transcription and stopped
audio. The resulting text remains in the composer until **Send** is pressed.
Silence preserves the existing draft and does not generate a message.

**Append to document draft** copies reviewed text into the original Markdown or
text editor; an original text selection instead offers explicit replacement.
This remains an unsaved, undoable human edit. Changing the document, its disk
version or the captured editor draft prevents the copy until the original state
is restored. HTML dictation stays in the linked composer.
In a notebook, **Dictate text** offers **Copy into notebook text draft**. The
text draft is retained locally; **Add text** remains a separate human action.
**Dictate about notebook** keeps text in the conversation only.

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
Long answers release consumed audio payloads as they play, while retaining
compact receipts to prevent a retried passage from being spoken twice.

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

In the native notebook, **Conversation** opens the same original-source panel;
**Dicter** and **Parler** start dictation and Voice directly. The panel sits
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
the original draft to finish loading before permitting a new capture. The separate
history catalogue loads independently; an error remains visible without blocking
that recovered draft or changing its source.
A microphone stop that cannot reach the Mac is retained with its exact controller
identity and released on return; it cannot stop a newer audio controller.
Earlier previews' equivalent local-root scope keys remain recoverable. This
compatibility is limited to that exact root; it does not combine worktrees,
projects or review scopes, or resurrect an explicitly cleared composer draft.
The current browser, provider, emulator and remaining physical
proof boundaries are in `docs/lifecycle/changes/active/android-convergence/verification.md`
in the Context Room source repository.

## Local voice dependency diagnostics

The assistant capabilities and local `doctor` expose deterministic optional audio
diagnostics. A model path alone is not configured transcription: the local Whisper
executable and a readable, nonempty regular model must be present. The diagnostics
never run recognition, play audio, download files or contact a paid replacement.
Readiness for an attempt is distinct from verified model compatibility, recording
quality or BOOX acoustics. Configuration belongs to
[runtime profiles](../system/runtime-profiles.md).

### Recovered recording attachments

**Recovered recordings** keeps explicitly selected historical PCM beside its
original source or conversation. Preview the exact target before attaching.
Loading, pressing Play, exporting the original PCM, and sending a message are
separate actions. Attachments never automatically become transcripts or agent
inputs. A newer document version is labelled without moving or deleting the
historical association. See [recording recovery](../system/lisiere-migration.md#explicit-original-pcm-associations).

## First-result latency and its measurement boundary

A cold request can wait for draft recovery, provider process initialization,
effective configuration checks, model discovery, thread start/resume, source
context, provider events, durable local changes and their client rendering.
Those phases are not all model inference. Historical native real-agent results
of **13.402 s** and **14.189 s** remain reference measurements; the ten-second
objective has not been demonstrated on the later code.

The application removes three avoidable waits. Draft recovery still gates send
and microphone controls, but the independent history catalogue no longer does.
Provider initialization retains its first already restricted stdio process only
when the effective configuration proves there is no enabled inherited MCP server.
When overrides are required it still replaces the probe and re-verifies the
restricted configuration before listing models or starting a thread. Only this
owned, idle, thread-free initialization probe gets prompt termination after one
EOF event-loop opportunity, instead of the five-second active-session grace.
Active session shutdown and all restrictions remain unchanged.

The first nonempty provider text event is saved synchronously, without the former
250 ms coalescing delay. Later deltas are still coalesced; completion and stop
flush the actual received text. This does not fabricate a token, redraw a cached
answer, pre-send a request or start another agent. Notebook progress includes
reached points and distance only after its mutation receipt is durable.

`GET /api/assistant/conversations/<id>` returns monotonic `operation.timing`
for the original request: authorization, queue, provider ready, thread ready,
context ready, dispatch, provider start/text/tool, first local mutation, first
draw segment of at least one document unit, first saved text and terminal local
status. The provider adapter separately exposes `setupTiming` for initialization,
configuration, optional isolated restart and model listing. Timings contain no
prompt, credential, file content or private source path. Missing milestones mean
not observed; a restored uncertain request does not receive invented measurements.

`toolWorkSumMs` is a sum and concurrent work can overlap. Provider-boundary waits
include process/IPC/scheduling, not just inference. Do not subtract these fields
to claim pure model latency or combine monotonic clocks from different devices.
`inferenceTimeMeasured` and `displayTimeMeasured` remain false. First saved text,
a first point and the first meaningful drawn segment are distinct milestones.
Browser assistant polling (500 ms), notebook refresh (900 ms), native transport,
painting and audio remain separate end-to-end costs, not removed by these changes.

The opt-in real-account verifier `test/agent/verify-codex.mjs` records setup,
thread and tool durations alongside its original first-useful metric and a new
first-segment metric. It does not impose a synthetic ten-second success. Run it
only with an authorized local provider and a new private evidence directory;
compare cold and resident requests, normal and retained-history contexts, then
measure actual browser/native rendering of the same request and revision. The
exact protocol and remaining native steps are in `RELAIS-CODEX-LOCAL.md` in the
source delivery. Deterministic transport fixtures verify waits and isolation,
not provider speed, language quality, display latency or physical BOOX behavior.
