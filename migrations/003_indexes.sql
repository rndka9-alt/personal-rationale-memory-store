CREATE INDEX IF NOT EXISTS memory_entries_status_idx ON memory_entries(status);
CREATE INDEX IF NOT EXISTS memory_entries_type_idx ON memory_entries(type);
CREATE INDEX IF NOT EXISTS memory_entries_metadata_idx ON memory_entries USING gin(metadata);
CREATE INDEX IF NOT EXISTS memory_chunks_entry_idx ON memory_chunks(entry_id);
CREATE INDEX IF NOT EXISTS memory_chunks_embedding_idx ON memory_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);
