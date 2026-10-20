// The "workflow parses" acceptance check of section 10: .github/workflows/backup.yml, the weekly
// mongodump of ADR-0002, is valid YAML and keeps the shape that makes it a safe backup. GitHub only
// reports a broken workflow after it is on main and the schedule fires, so this catches it first.
//
// Parsed with the `yaml` package because it reads YAML 1.2 by default: the top-level key `on` stays
// the string "on". A YAML 1.1 parser reads a bare `on` as the boolean true, so the trigger section
// would land under the key "true" and the schema below could not find it.
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDocument } from 'yaml';
import { z } from 'zod';

const WORKFLOW_FILE = path.resolve(import.meta.dirname, '../.github/workflows/backup.yml');
/** The step's env value: GitHub fills it from the repo secret at run time. */
const SECRET_REFERENCE = '${{ secrets.MONGODB_BACKUP_URI }}';
/** Where the dump step writes the archive, and what the upload step must pick up. */
const ARCHIVE_PATH = 'backup/bottlerun.archive.gz';
/**
 * A MongoDB URI with `user:password@` in it. `<` is excluded so the documented placeholder
 * (`mongodb+srv://<backup-user>:<password>@…`) in the file's header comment is allowed.
 */
const URI_WITH_CREDENTIALS = /mongodb(\+srv)?:\/\/[^\s'"<]+:[^\s'"<]+@/;

/** Read-only: the workflow reads nothing from the repo and writes nothing to it. */
const permissionsSchema = z.strictObject({ contents: z.literal('read') });

const stepSchema = z.object({
  name: z.string(),
  uses: z.string().optional(),
  run: z.string().optional(),
  env: z.record(z.string(), z.string()).optional(),
  with: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
});

/** The part of GitHub's workflow syntax this file uses. */
const workflowSchema = z.object({
  name: z.string(),
  on: z.strictObject({
    schedule: z.array(z.strictObject({ cron: z.string() })),
    // `workflow_dispatch:` with no inputs parses as null; the key is what matters.
    workflow_dispatch: z.null(),
  }),
  permissions: permissionsSchema,
  jobs: z.record(
    z.string(),
    z.object({
      'runs-on': z.string(),
      'timeout-minutes': z.number().int().positive().optional(),
      // A job may narrow the permissions, never widen them.
      permissions: permissionsSchema.optional(),
      steps: z.array(stepSchema),
    }),
  ),
});

const source = fs.readFileSync(WORKFLOW_FILE, 'utf8');
const document = parseDocument(source);
// parseDocument collects syntax errors instead of throwing. Broken YAML makes every check below
// meaningless, so it fails the whole file here, with the error's line and column.
const [firstYamlError] = document.errors;
if (firstYamlError) throw firstYamlError;
const workflow = workflowSchema.parse(document.toJS());
const steps = Object.values(workflow.jobs).flatMap((job) => job.steps);

describe('.github/workflows/backup.yml', () => {
  it('is valid YAML', () => {
    expect(document.errors).toEqual([]);
    expect(document.warnings).toEqual([]);
  });

  it('runs once a week on Monday, after the Sunday pickups, and can be started by hand', () => {
    expect(workflow.on.schedule).toHaveLength(1);
    const fields = workflow.on.schedule[0]?.cron.trim().split(/\s+/) ?? [];
    expect(fields).toHaveLength(5);
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields;
    expect(minute).toMatch(/^\d{1,2}$/);
    expect(hour).toMatch(/^\d{1,2}$/);
    // Every day of the month, every month, one day of the week: weekly.
    expect(dayOfMonth).toBe('*');
    expect(month).toBe('*');
    expect(dayOfWeek).toBe('1');
    expect(workflow.on).toHaveProperty('workflow_dispatch');
  });

  it('has read-only permissions and does not check out the repo', () => {
    // permissionsSchema already refused any key but `contents: read`; this states it plainly.
    expect(workflow.permissions).toEqual({ contents: 'read' });
    expect(steps.filter((step) => step.uses?.startsWith('actions/checkout'))).toEqual([]);
  });

  it('gives the dump step the URI from the secret through env, by name only', () => {
    const dumpSteps = steps.filter((step) => step.run?.includes('mongodump'));
    expect(dumpSteps).toHaveLength(1);
    const dumpStep = dumpSteps[0];
    expect(dumpStep?.env).toEqual({ MONGODB_BACKUP_URI: SECRET_REFERENCE });
    // Never `${{ secrets.… }}` pasted into the script, and docker gets the variable's name, not
    // its value, so the URI is not on any command line.
    expect(dumpStep?.run).not.toContain('secrets.');
    expect(dumpStep?.run).toMatch(/-e MONGODB_BACKUP_URI\s/);
    expect(dumpStep?.run).toContain(`/${ARCHIVE_PATH}`);
  });

  it('contains no MongoDB URI with credentials, so no secret is ever committed', () => {
    // The pattern itself must work, or the check below would pass for nothing.
    expect('mongodb+srv://backup:s3cret@cluster0.example.mongodb.net/bottlerun').toMatch(
      URI_WITH_CREDENTIALS,
    );
    expect('mongodb://backup:s3cret@localhost:27017/bottlerun').toMatch(URI_WITH_CREDENTIALS);
    expect(source).not.toMatch(URI_WITH_CREDENTIALS);
  });

  it('keeps the dump as an artifact for 90 days and fails when the file is missing', () => {
    const uploadSteps = steps.filter((step) => step.uses?.startsWith('actions/upload-artifact@'));
    expect(uploadSteps).toHaveLength(1);
    expect(uploadSteps[0]?.with).toMatchObject({
      path: ARCHIVE_PATH,
      'retention-days': 90,
      'if-no-files-found': 'error',
    });
  });

  it('gives every job a timeout, so a hung connection cannot run for hours', () => {
    const jobs = Object.values(workflow.jobs);
    expect(jobs).not.toHaveLength(0);
    for (const job of jobs) {
      expect(job['timeout-minutes']).toBeGreaterThan(0);
      expect(job['timeout-minutes']).toBeLessThanOrEqual(30);
    }
  });
});
