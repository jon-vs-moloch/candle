MVP Spec: Persistent Cognitive Agent with Chat Surface

## 1. Goal

Build an experimental harness for a model that is not just a turn-based chatbot.

The system should combine:
- a continuous internal process that maintains state over time
- an episodic external process where the user chats with it
- active context management driven by tools rather than by blindly replaying transcript history

The point of the MVP is to make this split visible and testable: the agent should feel like something that is continuously maintaining itself, while chat remains the main interface humans use to interact with it.

## 2. What Actually Matters

This spec is intentionally light on implementation details. Most structure here should be treated as guidance, not as a required schema or architecture.

The core requirements are:

1. Active context management via tools
- The system should decide what to keep active, compress, expand, reinforce, ignore, or surface.
- Context should be assembled from managed state, not from full transcript replay.

2. Separation of internal vs external processes
- There should be a continuous internal process that updates state in the background.
- There should be a separate chat process that handles user interactions as bounded episodes.
- These processes are related, but not identical.

3. UI visibility into both
- The user should be able to see:
- the chat interface
- the background process
- a representation of current internal state

## 3. Product Shape

Conceptually, the system has three layers:

### A. Internal state

This is the persistent state the system maintains over time.

It may include things like:
- memories
- summaries
- beliefs or world-model entities
- tasks
- hypotheses
- unresolved questions
- current priorities

The exact schema is not important for the MVP. What matters is that some state persists outside any single model invocation and can be actively managed.

### B. Background process

This is the continuous internal loop.

It may:
- update priorities
- compress or summarize state
- merge duplicate information
- maintain tasks
- revise interpretations
- prepare candidate proactive messages or updates

This process should continue independently of any one user turn.

### C. Chat process

This is the external conversational loop.

It should:
- accept user messages
- assemble a bounded context from managed internal state plus recent chat context
- produce replies
- write useful results back into internal state

Chat is episodic, but it interacts with a continuous underlying process.

## 4. Context Model

The model should not receive the entire chat transcript by default.

Instead, prompt context should be assembled from a mix of:
- the current user message
- relevant internal state selected by retrieval / prioritization
- a short window of raw recent chat turns
- summaries of older chat when useful
- system instructions

Important clarification:
- raw chat context should be part of the mix
- but not all raw chat context
- for MVP purposes, using only the last few turns is a good default

The exact number of turns is an implementation choice. The product requirement is simply that recent raw interaction remains available while older interaction is filtered, summarized, or otherwise mediated through state.

## 5. Active Context Management

The system should have tool-like operations for managing its own working set.

Examples:
- focus or pin something important
- summarize a cluster of material
- expand a summary back into detail
- merge overlapping items
- create or update a task
- update an interpreted belief / entity
- mark something as worth surfacing to the user
- decay or deprioritize stale material

These are capabilities, not required function names.

The key product behavior is that the model can participate in managing what remains active, instead of relying on static prompt construction alone.

## 6. Internal vs External Behavior

The system should distinguish between:

### Internal cognition
- continuous
- mostly hidden
- state-maintaining
- may produce candidate insights, reminders, or updates

### External chat
- user-facing
- bounded in context
- responsive to direct interaction
- able to draw from internal state

The internal process should not dump all thoughts into chat.

However, the model should be able to chat proactively when appropriate.
Examples:
- surfacing an important update
- asking for clarification when blocked
- warning about a contradiction or likely mistake
- following up on a pending task at a useful moment

So the rule is not "no proactive messages." The rule is "proactive communication is selective and policy-driven."

## 7. UI Requirements

The MVP UI should make the architecture legible.

At minimum, it should show:

1. Chat interface
- normal user / assistant conversation surface

2. Background process view
- evidence that internal processing is happening over time
- for example: status, recent actions, queued work, last run, current activity

3. Internal state view
- a readable representation of managed state
- for example: memories, tasks, entities, summaries, priorities, or relationships

The goal is not a perfect operator console. The goal is to let someone see the difference between:
- what the user said
- what the system is currently maintaining
- what the background process is doing

## 8. Suggested Minimal Behavior

The MVP should demonstrate:
- persistence across turns
- bounded context assembly rather than full transcript replay
- recent raw chat retained as part of context
- background maintenance of state
- separation between hidden internal updates and user-visible chat
- selective proactive communication

If those behaviors are visible, the MVP is doing the right thing even if the internal representation is simple.

## 9. Suggested Implementation Direction

These are suggestions, not requirements:
- one model is fine
- one persistent store is fine
- one background worker / timer loop is fine
- internal state can be very small and simple
- retrieval and summarization can be heuristic
- state views can start as crude debug panels

Avoid overbuilding the ontology or storage model too early.

The first version should optimize for answering these questions:
- Does this feel meaningfully different from normal chat?
- Does managed state improve coherence?
- Does the split between internal and external processes produce useful behavior?
- Does selective use of recent raw chat plus managed state work better than full-history prompting?

## 10. One-Sentence Summary

Build a chat-facing agent with a continuous internal state-maintenance process, where context is actively managed through tools, recent raw chat is included but bounded, and the UI exposes chat, background processing, and internal state as distinct but connected parts of the system.
