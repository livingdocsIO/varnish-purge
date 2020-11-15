--------------------------------------------------------------------------------
-- Up
--------------------------------------------------------------------------------
CREATE TABLE document_publication_events (
  id integer PRIMARY KEY NOT NULL,

  -- The event id we get from livingdocs
  idx integer NOT NULL,

  content_type_id integer NOT NULL,
  document_id integer NOT NULL,

  -- event id, normalized, so it doesn't bloat our table
  event_type integer NOT NULL,

  -- timestamp of event in milliseconds
  ts integer NOT NULL
);

CREATE TABLE document_content_types (
  id integer PRIMARY KEY NOT NULL,
  project_id integer NOT NULL,
  channel_id integer NOT NULL,
  document_type_handle text NOT NULL,
  content_type_handle text NOT NULL
);

CREATE TABLE purge_state (
  id integer PRIMARY KEY NOT NULL,
  project_id integer NOT NULL,
  position integer NOT NULL
);

CREATE INDEX document_publication_events_idx_on_idx ON document_publication_events (idx);
CREATE INDEX document_publication_events_idx_on_content_type_id ON document_publication_events (content_type_id);
CREATE INDEX document_content_types_idx_on_project_id_channel_type_handle ON document_content_types (project_id, content_type_handle);

--------------------------------------------------------------------------------
-- Down
--------------------------------------------------------------------------------
DROP TABLE publication_events;
DROP TABLE document_content_types;
