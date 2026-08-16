# Domain model

This document defines the stable language and product boundaries of Vault Knowledge Agent.

## Core concepts

**Knowledge Agent** — An assistant that treats the entire current Vault as its knowledge boundary, answers from traceable evidence and proposes knowledge-management changes.

**Vault Boundary** — The only Vault that one Agent run may read, search or propose changes to. Different Vaults remain isolated.

**Vault Evidence** — Information from a concrete note, path, property or relation that the user can inspect and verify.

**Grounded Answer** — An answer whose important claims are supported by explicit Vault Evidence.

**Knowledge Index** — A device-local, incrementally maintained retrieval view built from Vault content, metadata and links. It is not model memory and is never uploaded as a whole.

**Image Reference** — An image represented only by its path, metadata and note relations. Pixel content and OCR are outside the current scope.

**Task Session** — A device-local record of conversation, citations, retrieval traces and pending changes. It never becomes indexed Vault knowledge.

**Model Connection** — A device-local connection to a local or cloud model service. Available model IDs come from service discovery or explicit manual input.

**Shared Context** — The question, minimal relevant history and retrieved evidence subset authorized for one model request. It is never the complete Vault.

**Change Proposal** — A reviewable set of create, modify, move or delete operations. No write is applied until the user confirms selected changes.

**Vault Filesystem Mode** — An optional capability that exposes additional files inside the current Vault. It does not expose a shell or paths outside the Vault, and writes still require a Change Proposal.

**Knowledge Task** — A user-triggered Vault question, audit, synthesis or organization request. The Agent does not start autonomous background tasks.
