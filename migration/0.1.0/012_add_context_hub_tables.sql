-- =====================================================
-- Add Context Engineering Hub Tables
-- =====================================================
-- This migration adds the Context Engineering Hub feature to Archon,
-- enabling users to create and manage reusable templates for:
-- - Agents (AI agent definitions with prompts and tools)
-- - Steps (workflow step templates with sub-workflow support)
-- - Workflows (complete workflow sequences)
-- - Coding Standards (reusable coding standards library)
--
-- These templates can be used via:
-- 1. MCP Server (manual IDE agent usage)
-- 2. Agent Work Orders (automated workflow execution)
--
-- This is a core Archon feature (not optional).
-- =====================================================

BEGIN;

-- =====================================================
-- STEP 1: Create workflow step type enum
-- =====================================================

DO $$ BEGIN
  CREATE TYPE workflow_step_type AS ENUM (
    'planning',    -- Requirements analysis, design (≥1 required in workflow)
    'implement',   -- Code changes, features (≥1 required in workflow)
    'validate',    -- Testing, review, verification (≥1 required in workflow)
    'prime',       -- Context loading, repo priming (optional)
    'git'          -- Git operations: create-branch, commit, create-pr (optional)
  );
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

RAISE NOTICE '✓ Step 1: workflow_step_type enum created';

-- =====================================================
-- STEP 2: Create archon_agent_templates table
-- =====================================================

CREATE TABLE IF NOT EXISTS archon_agent_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  system_prompt TEXT NOT NULL,
  model TEXT DEFAULT 'sonnet',
  temperature REAL DEFAULT 0.0,
  tools JSONB DEFAULT '[]', -- Array of tool names: ["Read", "Write", "Edit", "Bash"]
  standards JSONB DEFAULT '{}', -- Default coding standards for this agent
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  version INTEGER DEFAULT 1,
  parent_template_id UUID REFERENCES archon_agent_templates(id) ON DELETE SET NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_agent_slug_version UNIQUE (slug, version)
);

CREATE INDEX IF NOT EXISTS idx_agent_templates_slug ON archon_agent_templates(slug);
CREATE INDEX IF NOT EXISTS idx_agent_templates_active ON archon_agent_templates(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_agent_templates_parent ON archon_agent_templates(parent_template_id);

COMMENT ON TABLE archon_agent_templates IS 'Reusable agent definitions with prompts, tools, and standards';
COMMENT ON COLUMN archon_agent_templates.tools IS 'Array of tool names this agent can use: ["Read", "Write", "Edit", "Bash"]';
COMMENT ON COLUMN archon_agent_templates.standards IS 'Default coding standards for this agent (JSONB)';
COMMENT ON COLUMN archon_agent_templates.version IS 'Version number for template versioning (updates create new versions)';

RAISE NOTICE '✓ Step 2: archon_agent_templates table created';

-- =====================================================
-- STEP 3: Create archon_step_templates table
-- =====================================================

CREATE TABLE IF NOT EXISTS archon_step_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  step_type workflow_step_type NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  prompt_template TEXT NOT NULL,
  agent_template_id UUID REFERENCES archon_agent_templates(id) ON DELETE SET NULL,
  sub_steps JSONB DEFAULT '[]', -- Array of sub-step configs for multi-agent workflows
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  version INTEGER DEFAULT 1,
  parent_template_id UUID REFERENCES archon_step_templates(id) ON DELETE SET NULL,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),

  CONSTRAINT unique_step_slug_version UNIQUE (slug, version)
);

CREATE INDEX IF NOT EXISTS idx_step_templates_type ON archon_step_templates(step_type);
CREATE INDEX IF NOT EXISTS idx_step_templates_slug ON archon_step_templates(slug);
CREATE INDEX IF NOT EXISTS idx_step_templates_active ON archon_step_templates(is_active) WHERE is_active = TRUE;
CREATE INDEX IF NOT EXISTS idx_step_templates_agent ON archon_step_templates(agent_template_id);

COMMENT ON TABLE archon_step_templates IS 'Workflow step templates with support for multi-agent sub-workflows';
COMMENT ON COLUMN archon_step_templates.sub_steps IS 'Array of sub-step configs: [{order, name, agent_template_slug, prompt_template, required}, ...]';
COMMENT ON COLUMN archon_step_templates.step_type IS 'Type of step: planning, implement, validate, prime, or git';

RAISE NOTICE '✓ Step 3: archon_step_templates table created';

-- =====================================================
-- STEP 4: Create archon_workflow_templates table
-- =====================================================

CREATE TABLE IF NOT EXISTS archon_workflow_templates (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  description TEXT,
  steps JSONB NOT NULL, -- Array of step configs: [{step_type, order, step_template_slug, pause_after}, ...]
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  created_by TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workflow_templates_slug ON archon_workflow_templates(slug);
CREATE INDEX IF NOT EXISTS idx_workflow_templates_active ON archon_workflow_templates(is_active) WHERE is_active = TRUE;

COMMENT ON TABLE archon_workflow_templates IS 'Complete workflow sequences (must have ≥1 planning, implement, validate step)';
COMMENT ON COLUMN archon_workflow_templates.steps IS 'Array of workflow steps (planning/implement/validate/prime/git)';

RAISE NOTICE '✓ Step 4: archon_workflow_templates table created';

-- =====================================================
-- STEP 5: Create archon_coding_standards table
-- =====================================================

CREATE TABLE IF NOT EXISTS archon_coding_standards (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  slug TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  language TEXT NOT NULL, -- 'typescript', 'python', 'rust', etc.
  description TEXT,
  standards JSONB NOT NULL, -- Linter config, rules, min coverage, etc.
  metadata JSONB DEFAULT '{}',
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_coding_standards_slug ON archon_coding_standards(slug);
CREATE INDEX IF NOT EXISTS idx_coding_standards_language ON archon_coding_standards(language);
CREATE INDEX IF NOT EXISTS idx_coding_standards_active ON archon_coding_standards(is_active) WHERE is_active = TRUE;

COMMENT ON TABLE archon_coding_standards IS 'Reusable coding standards library for different languages and tools';
COMMENT ON COLUMN archon_coding_standards.language IS 'Programming language: typescript, python, rust, etc.';
COMMENT ON COLUMN archon_coding_standards.standards IS 'Linter config, rules, min coverage (JSONB)';

RAISE NOTICE '✓ Step 5: archon_coding_standards table created';

-- =====================================================
-- STEP 6: Seed default templates
-- =====================================================

-- Seed agent templates
INSERT INTO archon_agent_templates (slug, name, description, system_prompt, model, tools, metadata)
VALUES
  ('python-backend-expert', 'Python Backend Expert', 'Expert in FastAPI, async Python, and backend architecture',
   'You are a Python backend development expert specializing in FastAPI, async programming, database design, and API architecture. You write clean, type-safe code following PEP 8 and modern Python best practices.',
   'sonnet', '["Read", "Write", "Edit", "Grep", "Bash"]'::jsonb, '{"tags": ["python", "backend", "fastapi"]}'::jsonb),

  ('code-reviewer', 'Code Reviewer', 'Expert code reviewer focusing on quality, security, and best practices',
   'You are an expert code reviewer with deep knowledge of software engineering principles, security best practices, and code quality standards. You provide constructive feedback and identify potential issues.',
   'sonnet', '["Read", "Grep"]'::jsonb, '{"tags": ["review", "security", "quality"]}'::jsonb),

  ('react-frontend-specialist', 'React Frontend Specialist', 'Expert in React, TypeScript, and modern frontend development',
   'You are a frontend development expert specializing in React, TypeScript, TanStack Query, and modern UI development. You build responsive, accessible, and performant user interfaces.',
   'sonnet', '["Read", "Write", "Edit", "Grep"]'::jsonb, '{"tags": ["react", "frontend", "typescript"]}'::jsonb)
ON CONFLICT (slug, version) DO NOTHING;

RAISE NOTICE '✓ Step 6a: Seeded 3 agent templates';

-- Seed step templates
INSERT INTO archon_step_templates (step_type, slug, name, description, prompt_template, agent_template_id, sub_steps)
SELECT
  'planning', 'standard-planning', 'Standard Planning', 'Requirements analysis and implementation planning',
  'Analyze the following request and create a detailed implementation plan:\n\n{{user_request}}\n\nConsider:\n- Requirements and constraints\n- Technical approach\n- Implementation steps\n- Testing strategy\n- Potential risks',
  (SELECT id FROM archon_agent_templates WHERE slug = 'python-backend-expert' LIMIT 1),
  '[]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM archon_step_templates WHERE slug = 'standard-planning');

INSERT INTO archon_step_templates (step_type, slug, name, description, prompt_template, agent_template_id, sub_steps)
SELECT
  'implement', 'standard-implement', 'Standard Implementation', 'Code implementation following the plan',
  'Implement the following plan:\n\n{{previous_output}}\n\nEnsure:\n- Clean, type-safe code\n- Proper error handling\n- Comprehensive logging\n- Following coding standards',
  (SELECT id FROM archon_agent_templates WHERE slug = 'python-backend-expert' LIMIT 1),
  '[]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM archon_step_templates WHERE slug = 'standard-implement');

INSERT INTO archon_step_templates (step_type, slug, name, description, prompt_template, agent_template_id, sub_steps)
SELECT
  'validate', 'standard-review', 'Standard Review', 'Code review and validation',
  'Review the implementation:\n\n{{previous_output}}\n\nCheck for:\n- Code quality and best practices\n- Security vulnerabilities\n- Test coverage\n- Documentation completeness',
  (SELECT id FROM archon_agent_templates WHERE slug = 'code-reviewer' LIMIT 1),
  '[]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM archon_step_templates WHERE slug = 'standard-review');

INSERT INTO archon_step_templates (step_type, slug, name, description, prompt_template, agent_template_id, sub_steps)
SELECT
  'prime', 'repo-priming', 'Repository Priming', 'Load repository context and architecture',
  'Prime your understanding of the repository:\n\nRepository: {{repository_url}}\nPriming Context: {{priming_context}}\n\nReview the codebase structure, architecture, and key files.',
  (SELECT id FROM archon_agent_templates WHERE slug = 'python-backend-expert' LIMIT 1),
  '[]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM archon_step_templates WHERE slug = 'repo-priming');

INSERT INTO archon_step_templates (step_type, slug, name, description, prompt_template, agent_template_id, sub_steps)
SELECT
  'git', 'create-pr', 'Create Pull Request', 'Create GitHub pull request with changes',
  'Create a pull request with the implemented changes:\n\nBranch: {{git_branch}}\nCommits: {{git_commits}}\n\nEnsure:\n- Clear PR title and description\n- Links to related issues\n- Test results included',
  (SELECT id FROM archon_agent_templates WHERE slug = 'python-backend-expert' LIMIT 1),
  '[]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM archon_step_templates WHERE slug = 'create-pr');

RAISE NOTICE '✓ Step 6b: Seeded 5 step templates';

-- Seed workflow templates
INSERT INTO archon_workflow_templates (slug, name, description, steps)
SELECT
  'standard-dev', 'Standard Development Workflow', 'Basic plan → implement → review workflow',
  '[
    {"step_type": "planning", "order": 1, "step_template_slug": "standard-planning", "pause_after": false},
    {"step_type": "implement", "order": 2, "step_template_slug": "standard-implement", "pause_after": false},
    {"step_type": "validate", "order": 3, "step_template_slug": "standard-review", "pause_after": false}
  ]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM archon_workflow_templates WHERE slug = 'standard-dev');

INSERT INTO archon_workflow_templates (slug, name, description, steps)
SELECT
  'fullstack-workflow', 'Fullstack Development Workflow', 'Complete workflow with priming and PR creation',
  '[
    {"step_type": "prime", "order": 1, "step_template_slug": "repo-priming", "pause_after": false},
    {"step_type": "planning", "order": 2, "step_template_slug": "standard-planning", "pause_after": false},
    {"step_type": "implement", "order": 3, "step_template_slug": "standard-implement", "pause_after": false},
    {"step_type": "validate", "order": 4, "step_template_slug": "standard-review", "pause_after": false},
    {"step_type": "git", "order": 5, "step_template_slug": "create-pr", "pause_after": false}
  ]'::jsonb
WHERE NOT EXISTS (SELECT 1 FROM archon_workflow_templates WHERE slug = 'fullstack-workflow');

RAISE NOTICE '✓ Step 6c: Seeded 2 workflow templates';

-- Seed coding standards
INSERT INTO archon_coding_standards (slug, name, language, description, standards)
VALUES
  ('typescript-strict', 'TypeScript Strict', 'typescript', 'TypeScript with strict mode and comprehensive type checking',
   '{"linter": "tsc", "strict": true, "noImplicitAny": true, "rules": ["no-any", "no-explicit-any"]}'::jsonb),

  ('python-ruff', 'Python Ruff Linter', 'python', 'Python linting with Ruff (fast Rust-based linter)',
   '{"linter": "ruff", "line_length": 120, "rules": ["E", "F", "I"], "exclude": ["migrations/", "tests/"]}'::jsonb),

  ('react-best-practices', 'React Best Practices', 'javascript', 'React development standards and best practices',
   '{"linter": "biome", "rules": ["react-hooks", "react-jsx-key"], "jsx": true, "formatting": {"line_width": 120}}'::jsonb)
ON CONFLICT (slug) DO NOTHING;

RAISE NOTICE '✓ Step 6d: Seeded 3 coding standards';

-- =====================================================
-- STEP 7: Create triggers for updated_at timestamps
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_agent_templates_updated_at
  BEFORE UPDATE ON archon_agent_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_step_templates_updated_at
  BEFORE UPDATE ON archon_step_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_workflow_templates_updated_at
  BEFORE UPDATE ON archon_workflow_templates
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_coding_standards_updated_at
  BEFORE UPDATE ON archon_coding_standards
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

RAISE NOTICE '✓ Step 7: Triggers created for updated_at timestamps';

-- =====================================================
-- STEP 8: Enable Context Hub feature by default
-- =====================================================

INSERT INTO archon_credentials (key, value, is_encrypted, category, description)
VALUES (
  'CONTEXT_HUB_ENABLED',
  'true',
  FALSE,
  'features',
  'Enable Context Engineering Hub for template management'
)
ON CONFLICT (key) DO NOTHING;

RAISE NOTICE '✓ Step 8: Context Hub feature enabled';

COMMIT;

-- =====================================================
-- Migration Summary
-- =====================================================

DO $$
DECLARE
  agent_count INT;
  step_count INT;
  workflow_count INT;
  standards_count INT;
BEGIN
  SELECT COUNT(*) INTO agent_count FROM archon_agent_templates;
  SELECT COUNT(*) INTO step_count FROM archon_step_templates;
  SELECT COUNT(*) INTO workflow_count FROM archon_workflow_templates;
  SELECT COUNT(*) INTO standards_count FROM archon_coding_standards;

  RAISE NOTICE '';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Context Engineering Hub Migration Complete';
  RAISE NOTICE '========================================';
  RAISE NOTICE 'Agent Templates: %', agent_count;
  RAISE NOTICE 'Step Templates: %', step_count;
  RAISE NOTICE 'Workflow Templates: %', workflow_count;
  RAISE NOTICE 'Coding Standards: %', standards_count;
  RAISE NOTICE '';
  RAISE NOTICE 'Next Steps:';
  RAISE NOTICE '1. Restart Archon services: docker compose restart';
  RAISE NOTICE '2. Enable Context Hub in Settings UI';
  RAISE NOTICE '3. Navigate to /context-hub to create templates';
  RAISE NOTICE '========================================';
END $$;
