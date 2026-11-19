"""AI Digital Legacy — persona memory + voice conversation feature.

Self-contained package mounted into the main FastAPI app via `legacy.routes.router`.
Every external dependency (database, file storage, speech-to-text, LLM,
embeddings, voice) sits behind a small interface so it can be swapped later.
"""
