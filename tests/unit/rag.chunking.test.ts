// Unit tests for policy loading and chunking. No network: the only I/O is
// reading the real policy files and a temporary fixture directory.
//
// node:fs/promises is mocked so the "reads the files only once" test can count
// real reads. The mock delegates to the real module, so every other test here
// reads the actual files.

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Relative imports on purpose: the "@/*" alias is a tsconfig path that Vitest
// does not resolve without extra config.
import { CHUNK_OVERLAP, CHUNK_SIZE } from '../../src/lib/config';
import {
  clearPolicyChunkCache,
  loadPolicyChunks,
  type PolicyChunk,
} from '../../src/lib/rag';

const readFileSpy = vi.hoisted(() => vi.fn());
const readdirSpy = vi.hoisted(() => vi.fn());

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  readFileSpy.mockImplementation(actual.readFile);
  readdirSpy.mockImplementation(actual.readdir);
  return { ...actual, readFile: readFileSpy, readdir: readdirSpy };
});

/** The four committed policy files, which the real-file tests assert against. */
const POLICY_FILES = [
  'damaged-or-wrong-item.md',
  'return-policy.md',
  'shipping-policy.md',
  'warranty-policy.md',
];

/**
 * RecursiveCharacterTextSplitter cuts on separators, so a piece can run a
 * little past chunkSize when the nearest separator does. The overlap is the
 * natural size of that slack.
 */
const SIZE_TOLERANCE = CHUNK_OVERLAP;

/** A section far longer than CHUNK_SIZE, built from whole sentences. */
function longSection(heading: string, sentences: number): string {
  const body = Array.from(
    { length: sentences },
    (_, i) =>
      `Sentence ${i + 1} explains a detail of the fixture policy in enough ` +
      `words that the section runs well past the chunk size limit.`,
  ).join(' ');
  return `## ${heading}\n\n${body}\n`;
}

describe('loadPolicyChunks', () => {
  beforeEach(() => {
    clearPolicyChunkCache();
    readFileSpy.mockClear();
    readdirSpy.mockClear();
  });

  describe('the real policy files', () => {
    let chunks: PolicyChunk[];

    beforeAll(async () => {
      clearPolicyChunkCache();
      chunks = await loadPolicyChunks();
    });

    it('returns chunks', () => {
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('gives every chunk a source, a heading and text', () => {
      for (const chunk of chunks) {
        expect(chunk.source).toMatch(/\.md$/);
        expect(chunk.heading.length).toBeGreaterThan(0);
        expect(chunk.text.length).toBeGreaterThan(0);
      }
    });

    it('never returns an empty or whitespace-only chunk', () => {
      for (const chunk of chunks) {
        expect(chunk.text.trim()).toBe(chunk.text);
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });

    it('includes the heading in the chunk text', () => {
      for (const chunk of chunks) {
        expect(chunk.text).toContain(chunk.heading);
      }
    });

    it('uses the file name alone as the source, not a path', () => {
      for (const chunk of chunks) {
        expect(chunk.source).not.toContain('/');
        expect(chunk.source).not.toContain('\\');
      }
    });

    it('represents all four policy files', () => {
      const sources = [...new Set(chunks.map((c) => c.source))].sort();
      expect(sources).toEqual(POLICY_FILES);
    });

    it('keeps every chunk within CHUNK_SIZE plus tolerance', () => {
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(
          CHUNK_SIZE + SIZE_TOLERANCE,
        );
      }
    });

    it('returns plain objects, not LangChain Documents', () => {
      for (const chunk of chunks) {
        expect(Object.keys(chunk).sort()).toEqual([
          'heading',
          'source',
          'text',
        ]);
        expect(chunk).not.toHaveProperty('pageContent');
        expect(chunk).not.toHaveProperty('metadata');
      }
    });
  });

  describe('a fixture directory', () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'policy-fixture-'));

      await writeFile(
        join(dir, 'short.md'),
        [
          '# Short fixture policy',
          '',
          '## First heading',
          '',
          'A short section that fits in one chunk.',
          '',
          '## Second heading',
          '',
          'Another short section.',
          '',
        ].join('\n'),
        'utf8',
      );

      await writeFile(
        join(dir, 'long.md'),
        `# Long fixture policy\n\n${longSection('A very long heading', 40)}`,
        'utf8',
      );

      // Must be ignored: only .md files are policy files.
      await writeFile(join(dir, 'notes.txt'), 'not a policy file', 'utf8');
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('reads only .md files', async () => {
      const chunks = await loadPolicyChunks(dir);
      const sources = [...new Set(chunks.map((c) => c.source))].sort();
      expect(sources).toEqual(['long.md', 'short.md']);
    });

    it('keeps the source and heading of each short section', async () => {
      const chunks = await loadPolicyChunks(dir);
      const short = chunks.filter((c) => c.source === 'short.md');

      expect(short).toHaveLength(2);
      expect(short.map((c) => c.heading)).toEqual([
        'First heading',
        'Second heading',
      ]);
      expect(short[0].text).toContain('## First heading');
      expect(short[0].text).toContain('fits in one chunk');
    });

    it('drops the title-only preamble', async () => {
      const chunks = await loadPolicyChunks(dir);
      expect(
        chunks.some((c) => c.heading === 'Short fixture policy'),
      ).toBe(false);
    });

    it('splits a long section into several chunks', async () => {
      const chunks = await loadPolicyChunks(dir);
      const long = chunks.filter((c) => c.source === 'long.md');
      expect(long.length).toBeGreaterThan(1);
    });

    it('keeps source and heading on every piece of a split section', async () => {
      const chunks = await loadPolicyChunks(dir);
      const long = chunks.filter((c) => c.source === 'long.md');

      for (const chunk of long) {
        expect(chunk.source).toBe('long.md');
        expect(chunk.heading).toBe('A very long heading');
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });

    it('keeps every piece of a split section within CHUNK_SIZE plus tolerance', async () => {
      const chunks = await loadPolicyChunks(dir);
      for (const chunk of chunks) {
        expect(chunk.text.length).toBeLessThanOrEqual(
          CHUNK_SIZE + SIZE_TOLERANCE,
        );
      }
    });

    it('loses none of the long section to the split', async () => {
      const chunks = await loadPolicyChunks(dir);
      const long = chunks.filter((c) => c.source === 'long.md');

      // Every sentence survives somewhere, so the split drops no content.
      for (const marker of ['Sentence 1 ', 'Sentence 20 ', 'Sentence 40 ']) {
        expect(long.some((c) => c.text.includes(marker))).toBe(true);
      }
    });
  });

  describe('caching', () => {
    let dir: string;

    beforeAll(async () => {
      dir = await mkdtemp(join(tmpdir(), 'policy-cache-'));
      await writeFile(
        join(dir, 'cached.md'),
        '# Cached\n\n## A heading\n\nSome policy text.\n',
        'utf8',
      );
    });

    afterAll(async () => {
      await rm(dir, { recursive: true, force: true });
    });

    it('reads the files only once across two calls', async () => {
      const first = await loadPolicyChunks(dir);
      const readsAfterFirst = readFileSpy.mock.calls.length;

      const second = await loadPolicyChunks(dir);

      expect(readsAfterFirst).toBe(1);
      expect(readFileSpy.mock.calls.length).toBe(readsAfterFirst);
      expect(readdirSpy.mock.calls.length).toBe(1);
      expect(second).toEqual(first);
    });

    it('shares one read between two overlapping calls', async () => {
      // Caching the promise, not the result, is what makes this hold: both
      // calls start before either has finished reading.
      const [first, second] = await Promise.all([
        loadPolicyChunks(dir),
        loadPolicyChunks(dir),
      ]);

      expect(readFileSpy.mock.calls.length).toBe(1);
      expect(second).toEqual(first);
    });

    it('does not serve one directory from another directory cache', async () => {
      const fromFixture = await loadPolicyChunks(dir);
      const fromReal = await loadPolicyChunks();

      expect(fromFixture.map((c) => c.source)).toEqual(['cached.md']);
      expect(fromReal.some((c) => c.source === 'return-policy.md')).toBe(true);
    });
  });
});
