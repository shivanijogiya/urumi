-- 002_tool_permissions: per-role and per-user tool rules (ADR 008, packages/contracts/src/permissions.ts).
-- A tool no rule allows is hidden from tools/list and rejected by callTool (audit outcome 'denied').

CREATE TABLE tool_permissions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  role        text CHECK (role IN ('admin', 'member')),
  user_id     uuid REFERENCES users ON DELETE CASCADE,
  server_slug text NOT NULL CHECK (server_slug = '*' OR server_slug ~ '^[a-z0-9](?:[a-z0-9-]{0,18}[a-z0-9])?$'),
  tool        text NOT NULL CHECK (tool ~ '^(?:\*|[A-Za-z0-9_-]{1,64}\*?)$'),
  effect      text NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT tool_permissions_one_subject CHECK ((role IS NULL) <> (user_id IS NULL))
);
CREATE UNIQUE INDEX tool_permissions_role_uq ON tool_permissions (role, server_slug, tool)
  WHERE role IS NOT NULL;
CREATE UNIQUE INDEX tool_permissions_user_uq ON tool_permissions (user_id, server_slug, tool)
  WHERE user_id IS NOT NULL;

-- Default policy. Admins: everything. Members: read-only tools of the three demo upstreams.
-- Not granted to members (so denied): woo create_product / update_order_status, everything's
-- get-env (prints the server's environment), get-header-params and the trigger/toggle tools, and
-- every GitLab write tool. Admins can change all of this at /api/permissions (dashboard: Permissions).
INSERT INTO tool_permissions (role, server_slug, tool, effect) VALUES
  ('admin',  '*',          '*',                          'allow'),
  ('member', 'woo',        'list_products',              'allow'),
  ('member', 'woo',        'list_orders',                'allow'),
  ('member', 'woo',        'get_order',                  'allow'),
  ('member', 'everything', 'echo',                       'allow'),
  ('member', 'everything', 'get-sum',                    'allow'),
  ('member', 'everything', 'get-tiny-image',             'allow'),
  ('member', 'everything', 'get-annotated-message',      'allow'),
  ('member', 'everything', 'get-structured-content',     'allow'),
  ('member', 'everything', 'get-resource-links',         'allow'),
  ('member', 'everything', 'get-resource-reference',     'allow'),
  ('member', 'gitlab',     'get_*',                      'allow'),
  ('member', 'gitlab',     'list_*',                     'allow'),
  ('member', 'gitlab',     'search',                     'allow'),
  ('member', 'gitlab',     'search_labels',              'allow'),
  ('member', 'gitlab',     'semantic_search',            'allow');
