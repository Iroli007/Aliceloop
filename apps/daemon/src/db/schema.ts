export const schemaStatements = [
  `
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      kind TEXT NOT NULL,
      is_default INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS projects_kind_default_idx
    ON projects (kind, is_default, updated_at DESC)
  `,
  `
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      project_id TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      workset_state_json TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE SET NULL
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS sessions_project_updated_idx
    ON sessions (project_id, updated_at DESC)
  `,
  `
    CREATE TABLE IF NOT EXISTS session_focus_state (
      session_id TEXT PRIMARY KEY,
      goal TEXT NOT NULL DEFAULT '',
      constraints_json TEXT NOT NULL DEFAULT '[]',
      priorities_json TEXT NOT NULL DEFAULT '[]',
      next_step TEXT NOT NULL DEFAULT '',
      done_criteria_json TEXT NOT NULL DEFAULT '[]',
      blockers_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS session_rolling_summary (
      session_id TEXT PRIMARY KEY,
      current_phase TEXT NOT NULL DEFAULT '',
      summary TEXT NOT NULL DEFAULT '',
      completed_json TEXT NOT NULL DEFAULT '[]',
      remaining_json TEXT NOT NULL DEFAULT '[]',
      decisions_json TEXT NOT NULL DEFAULT '[]',
      summarized_turn_count INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
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
    CREATE TABLE IF NOT EXISTS message_reactions (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      emoji TEXT NOT NULL,
      source_device_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (message_id) REFERENCES session_messages(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE UNIQUE INDEX IF NOT EXISTS message_reactions_message_emoji_device_idx
    ON message_reactions (message_id, emoji, source_device_id)
  `,
  `
    CREATE INDEX IF NOT EXISTS message_reactions_message_created_idx
    ON message_reactions (message_id, created_at)
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
      last_seen_at TEXT NOT NULL,
      capabilities_json TEXT NOT NULL DEFAULT '{}'
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
    CREATE TABLE IF NOT EXISTS cron_jobs (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      schedule_type TEXT NOT NULL,
      schedule_config TEXT NOT NULL,
      schedule_label TEXT NOT NULL,
      prompt TEXT NOT NULL,
      session_id TEXT,
      status TEXT NOT NULL,
      last_error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      last_run_at TEXT,
      next_run_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS cron_jobs_status_next_run_idx
    ON cron_jobs (status, next_run_at)
  `,
  `
    CREATE TABLE IF NOT EXISTS plan_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      title TEXT NOT NULL,
      goal TEXT NOT NULL,
      steps_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      approved_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS session_plan_modes (
      session_id TEXT PRIMARY KEY,
      active INTEGER NOT NULL DEFAULT 0,
      active_plan_id TEXT,
      entered_at TEXT,
      updated_at TEXT NOT NULL,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE,
      FOREIGN KEY (active_plan_id) REFERENCES plan_runs(id) ON DELETE SET NULL
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS session_plan_modes_active_updated_idx
    ON session_plan_modes (active, updated_at DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS plan_runs_status_updated_idx
    ON plan_runs (status, updated_at)
  `,
  `
    CREATE TABLE IF NOT EXISTS mission_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      title TEXT NOT NULL,
      objective TEXT NOT NULL,
      roles_json TEXT NOT NULL,
      plan_id TEXT,
      task_ids_json TEXT NOT NULL,
      status TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE SET NULL
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS mission_runs_status_updated_idx
    ON mission_runs (status, updated_at)
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
    CREATE TABLE IF NOT EXISTS memories (
      id TEXT PRIMARY KEY,
      content TEXT NOT NULL,
      source TEXT NOT NULL CHECK(source IN ('auto', 'manual')),
      durability TEXT NOT NULL CHECK(durability IN ('permanent', 'temporary')),
      project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
      session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
      fact_kind TEXT CHECK(fact_kind IN ('preference', 'constraint', 'decision', 'profile', 'account', 'workflow', 'other')),
      fact_key TEXT,
      fact_state TEXT NOT NULL DEFAULT 'active' CHECK(fact_state IN ('active', 'superseded', 'retracted')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      access_count INTEGER NOT NULL DEFAULT 0,
      related_topics TEXT NOT NULL DEFAULT '[]'
    )
  `,
  `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_search_fts USING fts5(
      memory_id UNINDEXED,
      search_text,
      tokenize='trigram'
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS memory_metadata (
      memory_id TEXT PRIMARY KEY,
      embedding_model TEXT NOT NULL,
      embedding_dimension INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      memory_id TEXT PRIMARY KEY,
      embedding BLOB NOT NULL,
      FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS memory_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS memories_project_scope_idx
    ON memories (project_id, fact_state, updated_at DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS memories_session_scope_idx
    ON memories (session_id, fact_state, updated_at DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS memories_source_idx
    ON memories (source)
  `,
  `
    CREATE INDEX IF NOT EXISTS memories_durability_idx
    ON memories (durability)
  `,
  `
    CREATE INDEX IF NOT EXISTS memories_fact_state_idx
    ON memories (fact_state, updated_at DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS memories_fact_lookup_idx
    ON memories (fact_kind, fact_key, fact_state)
  `,
  `
    CREATE INDEX IF NOT EXISTS memories_created_idx
    ON memories (created_at DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS memories_updated_idx
    ON memories (updated_at DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS memories_access_idx
    ON memories (access_count DESC)
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
  `
    CREATE TABLE IF NOT EXISTS session_generated_files (
      session_id TEXT NOT NULL,
      path TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      deleted_at TEXT,
      PRIMARY KEY (session_id, path),
      FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
    )
  `,
  `
    CREATE INDEX IF NOT EXISTS session_generated_files_session_updated_idx
    ON session_generated_files (session_id, updated_at DESC)
  `,
  `
    CREATE INDEX IF NOT EXISTS session_generated_files_path_deleted_idx
    ON session_generated_files (path, deleted_at)
  `,
  `
    CREATE TABLE IF NOT EXISTS runtime_settings (
      id TEXT PRIMARY KEY,
      sandbox_profile TEXT NOT NULL,
      auto_approve_tool_requests INTEGER NOT NULL DEFAULT 1,
      tool_permission_rules_json TEXT NOT NULL DEFAULT '{"allow":[],"deny":[],"ask":[]}',
      reasoning_effort TEXT NOT NULL DEFAULT 'medium',
      tool_provider_id TEXT,
      tool_model TEXT,
      recent_turns_count INTEGER NOT NULL DEFAULT 4,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS mcp_server_installs (
      server_id TEXT PRIMARY KEY,
      install_source TEXT NOT NULL,
      installed_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `,
  `
    CREATE TABLE IF NOT EXISTS user_profile (
      id TEXT PRIMARY KEY,
      display_name TEXT,
      preferred_language TEXT,
      timezone TEXT,
      code_style TEXT,
      notes TEXT,
      updated_at TEXT NOT NULL
    )
  `,
];
