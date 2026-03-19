export const schemaStatements = [
  `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS attachments (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      file_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      byte_size INTEGER NOT NULL,
      storage_path TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS session_messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachment_ids TEXT NOT NULL,
      status TEXT NOT NULL,
      source_device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS session_messages_session_client_message_id_idx
    ON session_messages (session_id, client_message_id)
  `,
  `
    CREATE TABLE IF NOT EXISTS session_events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS session_events_session_seq_idx
    ON session_events (session_id, seq)
  `,
  `
    CREATE TABLE IF NOT EXISTS device_presence (
      device_id TEXT PRIMARY KEY,
      device_type TEXT NOT NULL,
      label TEXT NOT NULL,
      status TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS job_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS provider_configs (
      provider_id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      transport TEXT,
      base_url TEXT NOT NULL,
      model TEXT NOT NULL,
      api_key TEXT,
      enabled INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS library_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      source_kind TEXT NOT NULL,
      document_kind TEXT NOT NULL,
      source_path TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_attention_label TEXT
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS document_structures (
      id TEXT PRIMARY KEY,
      library_item_id TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      root_section_keys TEXT NOT NULL,
      FOREIGN KEY (library_item_id) REFERENCES library_items(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS section_spans (
      id TEXT PRIMARY KEY,
      library_item_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      title TEXT NOT NULL,
      page_from INTEGER NOT NULL,
      page_to INTEGER NOT NULL,
      parent_key TEXT,
      order_index INTEGER NOT NULL,
      FOREIGN KEY (library_item_id) REFERENCES library_items(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS section_spans_library_section_key_idx
    ON section_spans (library_item_id, section_key)
  `,
  `
    CREATE TABLE IF NOT EXISTS study_artifacts (
      id TEXT PRIMARY KEY,
      library_item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      body TEXT NOT NULL DEFAULT '',
      related_library_title TEXT NOT NULL,
      updated_at_label TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (library_item_id) REFERENCES library_items(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      detail TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      updated_at_label TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS content_blocks (
      id TEXT PRIMARY KEY,
      library_item_id TEXT NOT NULL,
      section_key TEXT NOT NULL,
      section_label TEXT NOT NULL,
      page_from INTEGER NOT NULL,
      page_to INTEGER NOT NULL,
      block_kind TEXT NOT NULL,
      content TEXT NOT NULL,
      FOREIGN KEY (library_item_id) REFERENCES library_items(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE VIRTUAL TABLE IF NOT EXISTS content_blocks_fts USING fts5(
      content_block_id UNINDEXED,
      library_item_id UNINDEXED,
      section_key UNINDEXED,
      content
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS cross_references (
      id TEXT PRIMARY KEY,
      source_kind TEXT NOT NULL,
      source_ref TEXT NOT NULL,
      target_kind TEXT NOT NULL,
      target_ref TEXT NOT NULL,
      label TEXT NOT NULL,
      score REAL NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS attention_state (
      id TEXT PRIMARY KEY,
      current_library_item_id TEXT,
      current_library_title TEXT,
      current_section_key TEXT,
      current_section_label TEXT,
      focus_summary TEXT NOT NULL,
      concepts TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS attention_events (
      id TEXT PRIMARY KEY,
      library_item_id TEXT NOT NULL,
      section_key TEXT,
      concept_key TEXT,
      reason TEXT NOT NULL,
      weight REAL NOT NULL,
      occurred_at TEXT NOT NULL,
      FOREIGN KEY (library_item_id) REFERENCES library_items(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS memory_notes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      source TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_notes_fts USING fts5(
      memory_id UNINDEXED, kind UNINDEXED, content
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS sandbox_runs (
      id TEXT PRIMARY KEY,
      primitive TEXT NOT NULL,
      status TEXT NOT NULL,
      target_path TEXT,
      command TEXT,
      args_json TEXT NOT NULL,
      cwd TEXT,
      detail TEXT NOT NULL,
      created_at TEXT NOT NULL,
      finished_at TEXT
    )
  `,
];
