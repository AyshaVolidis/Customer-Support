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
  embedText,
  loadPolicyChunks,
  resetPolicyChunksForTests,
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
 * The title of each policy file, taken from its own '# ' line.
 *
 * Note damaged-or-wrong-item.md titles itself 'Damaged, defective or wrong
 * item' — the file name is not the title, which is the point of reading it
 * from the content.
 */
const POLICY_TITLES: Record<string, string> = {
  'damaged-or-wrong-item.md': 'Damaged, defective or wrong item',
  'return-policy.md': 'Return policy',
  'shipping-policy.md': 'Shipping policy',
  'warranty-policy.md': 'Warranty policy',
};

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
    resetPolicyChunksForTests();
    readFileSpy.mockClear();
    readdirSpy.mockClear();
  });

  describe('the real policy files', () => {
    let chunks: PolicyChunk[];

    beforeAll(async () => {
      resetPolicyChunksForTests();
      chunks = await loadPolicyChunks();
    });

    it('returns chunks', () => {
      expect(chunks.length).toBeGreaterThan(0);
    });

    it('gives every chunk a source, a title, a heading and text', () => {
      for (const chunk of chunks) {
        expect(chunk.source).toMatch(/\.md$/);
        expect(chunk.title.length).toBeGreaterThan(0);
        expect(chunk.heading.length).toBeGreaterThan(0);
        expect(chunk.text.length).toBeGreaterThan(0);
      }
    });

    it("takes each chunk's title from its file's own '# ' line", () => {
      for (const chunk of chunks) {
        expect(chunk.title).toBe(POLICY_TITLES[chunk.source]);
      }
    });

    it('gives every chunk of a file the same title', () => {
      const titlesBySource = new Map<string, Set<string>>();
      for (const chunk of chunks) {
        const seen = titlesBySource.get(chunk.source) ?? new Set<string>();
        seen.add(chunk.title);
        titlesBySource.set(chunk.source, seen);
      }

      for (const [source, titles] of titlesBySource) {
        expect([...titles], `titles found in ${source}`).toHaveLength(1);
      }
    });

    it('does not use the heading as the title', () => {
      // The title names the policy, the heading names the section. A chunk
      // whose title equalled its heading would have lost that distinction.
      for (const chunk of chunks) {
        expect(chunk.title).not.toBe(chunk.heading);
      }
    });

    it('never returns an empty or whitespace-only chunk', () => {
      for (const chunk of chunks) {
        expect(chunk.text.trim()).toBe(chunk.text);
        expect(chunk.text.trim().length).toBeGreaterThan(0);
      }
    });

    it("chunk text never starts with a '#' heading line", () => {
      // The heading lives in the `heading` field only, so a chunk's text is
      // its body and never opens with the markdown heading it came under.
      for (const chunk of chunks) {
        expect(chunk.text.startsWith('#')).toBe(false);
        expect(chunk.text).not.toContain(`## ${chunk.heading}`);
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
          CHUNK_SIZE,
        );
      }
    });

    it('returns plain objects, not LangChain Documents', () => {
      for (const chunk of chunks) {
        expect(Object.keys(chunk).sort()).toEqual([
          'heading',
          'source',
          'text',
          'title',
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

      // No '# ' line at all, so its title has to fall back to the file name.
      await writeFile(
        join(dir, 'untitled.md'),
        '## Only a section heading\n\nA section with no document title above it.\n',
        'utf8',
      );

      // A preamble with a body under the title, so it survives as a chunk and
      // its '# Title' line has to be dropped from the text.
      await writeFile(
        join(dir, 'preamble.md'),
        [
          '# Preamble policy',
          '',
          'An intro paragraph before any section.',
          '',
          '## A section',
          '',
          'Section body.',
          '',
        ].join('\n'),
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
      expect(sources).toEqual([
        'long.md',
        'preamble.md',
        'short.md',
        'untitled.md',
      ]);
    });

    it("drops the '# Title' line from a preamble chunk's text", async () => {
      const chunks = await loadPolicyChunks(dir);
      const preamble = chunks.find(
        (c) => c.source === 'preamble.md' && c.heading === 'Preamble policy',
      );

      expect(preamble).toBeDefined();
      expect(preamble!.text).toBe('An intro paragraph before any section.');
      expect(preamble!.text).not.toContain('#');
    });

    it('keeps a preamble and its sections as separate chunks', async () => {
      const chunks = await loadPolicyChunks(dir);
      const fromFile = chunks.filter((c) => c.source === 'preamble.md');

      expect(fromFile.map((c) => c.heading)).toEqual([
        'Preamble policy',
        'A section',
      ]);
      expect(fromFile.map((c) => c.text)).toEqual([
        'An intro paragraph before any section.',
        'Section body.',
      ]);
    });

    it("takes the title from the file's '# ' line", async () => {
      const chunks = await loadPolicyChunks(dir);
      const short = chunks.filter((c) => c.source === 'short.md');

      expect(short.length).toBeGreaterThan(0);
      for (const chunk of short) {
        expect(chunk.title).toBe('Short fixture policy');
      }
    });

    it('falls back to the file name when there is no title', async () => {
      const chunks = await loadPolicyChunks(dir);
      const untitled = chunks.filter((c) => c.source === 'untitled.md');

      expect(untitled.length).toBeGreaterThan(0);
      for (const chunk of untitled) {
        expect(chunk.title).toBe('untitled.md');
      }
    });

    it('does not mistake a section heading for the document title', async () => {
      const chunks = await loadPolicyChunks(dir);
      const untitled = chunks.find((c) => c.source === 'untitled.md');

      // The file's only heading is '## Only a section heading'; a '##' line is
      // not a title, so the fallback must win.
      expect(untitled!.heading).toBe('Only a section heading');
      expect(untitled!.title).toBe('untitled.md');
    });

    it('keeps the source and heading of each short section', async () => {
      const chunks = await loadPolicyChunks(dir);
      const short = chunks.filter((c) => c.source === 'short.md');

      expect(short).toHaveLength(2);
      expect(short.map((c) => c.heading)).toEqual([
        'First heading',
        'Second heading',
      ]);
      // The body alone: the heading line is in `heading`, not in `text`.
      expect(short[0].text).toBe('A short section that fits in one chunk.');
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

    it('keeps source, title and heading on every piece of a split section', async () => {
      const chunks = await loadPolicyChunks(dir);
      const long = chunks.filter((c) => c.source === 'long.md');

      expect(long.length).toBeGreaterThan(1);
      for (const chunk of long) {
        expect(chunk.source).toBe('long.md');
        expect(chunk.title).toBe('Long fixture policy');
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

    it('does not cache a failure, so the next call tries again', async () => {
      const missing = join(tmpdir(), 'policy-dir-that-does-not-exist');

      await expect(loadPolicyChunks(missing)).rejects.toThrow();
      await expect(loadPolicyChunks(missing)).rejects.toThrow();

      // Two real attempts, not one attempt and a cached rejection.
      const attempts = readdirSpy.mock.calls.filter(
        (call) => call[0] === missing,
      );
      expect(attempts).toHaveLength(2);
    });

    it('still works on a valid directory after a failed load', async () => {
      const missing = join(tmpdir(), 'policy-dir-that-does-not-exist');

      await expect(loadPolicyChunks(missing)).rejects.toThrow();

      // A failure must not poison the cache for other directories, nor leave
      // the module in a state where the next real load cannot proceed.
      const chunks = await loadPolicyChunks(dir);
      expect(chunks.map((c) => c.source)).toEqual(['cached.md']);
      expect(chunks[0].title).toBe('Cached');
    });

    it('does not serve one directory from another directory cache', async () => {
      const fromFixture = await loadPolicyChunks(dir);
      const fromReal = await loadPolicyChunks();

      expect(fromFixture.map((c) => c.source)).toEqual(['cached.md']);
      expect(fromReal.some((c) => c.source === 'return-policy.md')).toBe(true);
    });
  });
});

describe('embedText', () => {
  beforeEach(() => {
    resetPolicyChunksForTests();
  });

  it('starts with the title and the heading', async () => {
    const chunks = await loadPolicyChunks();

    for (const chunk of chunks) {
      const prefix = `${chunk.title} > ${chunk.heading}: `;
      // Sliced rather than startsWith, so a failure shows the actual prefix.
      expect(embedText(chunk).slice(0, prefix.length)).toBe(prefix);
    }
  });

  it('uses the policy title, not the file name', async () => {
    const chunks = await loadPolicyChunks();
    const chunk = chunks.find(
      (c) => c.source === 'damaged-or-wrong-item.md',
    );

    expect(embedText(chunk!)).toContain('Damaged, defective or wrong item > ');
    expect(embedText(chunk!)).not.toContain('damaged-or-wrong-item.md');
  });

  it('states the heading once, in the prefix', async () => {
    const chunks = await loadPolicyChunks();
    const chunk = chunks.find(
      (c) => c.source === 'return-policy.md' && c.heading === 'Refund timing',
    );

    expect(chunk).toBeDefined();
    // The heading line is already out of the stored text...
    expect(chunk!.text).not.toContain('## Refund timing');

    const embedded = embedText(chunk!);
    // ...so the embedded string names it exactly once, in the prefix.
    expect(embedded).not.toContain('## Refund timing');
    expect(embedded.split('Refund timing')).toHaveLength(2);
  });

  it('leaves the chunk itself unchanged', async () => {
    const chunks = await loadPolicyChunks();

    for (const chunk of chunks) {
      const before = chunk.text;
      embedText(chunk);
      // A view for the embedder, not a rewrite: the chunk is left alone.
      expect(chunk.text).toBe(before);
    }
  });

  it('is the title, the heading and then the stored text', () => {
    const chunk: PolicyChunk = {
      source: 'return-policy.md',
      title: 'Return policy',
      heading: 'Refund timing',
      text: 'Refunds take 5 to 7 business days.',
    };

    expect(embedText(chunk)).toBe(
      'Return policy > Refund timing: Refunds take 5 to 7 business days.',
    );
  });

  it('passes the stored text through verbatim', () => {
    // No rewriting here: a '#' inside a body is content, not a heading, and
    // embedText must not start trimming it.
    const chunk: PolicyChunk = {
      source: 'return-policy.md',
      title: 'Return policy',
      heading: 'Refund timing',
      text: 'Use code #REFUND when you ask.',
    };

    expect(embedText(chunk)).toBe(
      'Return policy > Refund timing: Use code #REFUND when you ask.',
    );
  });

  it('uses the title alone when a chunk has no heading', () => {
    const preamble: PolicyChunk = {
      source: 'shipping-policy.md',
      title: 'Shipping policy',
      heading: '',
      text: 'This policy covers every order placed on the store.',
    };

    expect(embedText(preamble)).toBe(
      'Shipping policy: This policy covers every order placed on the store.',
    );
  });

  it('does not repeat a title that is also the heading', () => {
    // A preamble chunk takes the '# ' line as its heading, so title and
    // heading are the same string; stating it twice would waste the prefix.
    const preamble: PolicyChunk = {
      source: 'shipping-policy.md',
      title: 'Shipping policy',
      heading: 'Shipping policy',
      text: 'This policy covers every order.',
    };

    expect(embedText(preamble)).toBe(
      'Shipping policy: This policy covers every order.',
    );
  });

  it('falls back to the file name when a file has no title', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'policy-embed-'));
    try {
      await writeFile(
        join(dir, 'untitled.md'),
        '## A heading\n\nSome text.\n',
        'utf8',
      );

      const chunks = await loadPolicyChunks(dir);

      expect(embedText(chunks[0])).toBe('untitled.md > A heading: Some text.');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
