export const schemaStatements = [
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
    CREATE TABLE IF NOT EXISTS study_artifacts (
      id TEXT PRIMARY KEY,
      library_item_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      related_library_title TEXT NOT NULL,
      updated_at_label TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (library_item_id) REFERENCES library_items(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS task_runs (
      id TEXT PRIMARY KEY,
      task_type TEXT NOT NULL,
      status TEXT NOT NULL,
      title TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_at_label TEXT NOT NULL
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
];

