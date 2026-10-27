import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_SETTINGS } from '@harv/shared';
import { afterAll, describe, expect, it, vi } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'harv-settings-'));
vi.stubEnv('HARV_HOME', home);
afterAll(() => rmSync(home, { recursive: true, force: true }));
const { cleanSettings, loadSettings, updateSettings } = await import('./settings.ts');
const { findBackground, imageType, removeBackground, saveBackground } = await import('./background.ts');

describe('settings', () => {
  it('drops invalid values and keeps the rest', () => {
    expect(cleanSettings({ motion: 'yes', accent: 'red', allowFable: true, protectedPaths: ['C:\\A', ' C:\\A ', 3, ''] })).toEqual({
      ...DEFAULT_SETTINGS,
      allowFable: true,
      protectedPaths: ['C:\\A'],
    });
  });

  it('turns the one-day seeThrough switch into the backdrop choice, and checks the new look fields', () => {
    expect(cleanSettings({ seeThrough: true })).toMatchObject({ backdrop: 'seeThrough' });
    expect(cleanSettings({ seeThrough: true, backdrop: 'plain' })).toMatchObject({ backdrop: 'plain' });
    expect(cleanSettings({ backdrop: 'video', glassBlur: 99, frost: 'no' })).toMatchObject({
      backdrop: 'photo',
      glassBlur: 40,
      frost: true,
    });
  });

  it('clamps numbers, checks choices and keeps lists tidy', () => {
    const s = cleanSettings({
      accent: '#12ab9f',
      backgroundBlur: 99,
      scrim: -5,
      uiScale: 112.4,
      density: 'tiny',
      metricsMs: 3000,
      tempUnit: 'F',
      compactRows: ['net', 'cpu', 'bogus'],
      warnSession: [95, 75, 75, 150, 'x'],
      warnWeekly: [],
      workDir: 'relative\\path',
    });
    expect(s).toMatchObject({
      accent: '#12AB9F',
      backgroundBlur: 30,
      scrim: 0,
      uiScale: 112,
      density: DEFAULT_SETTINGS.density,
      metricsMs: DEFAULT_SETTINGS.metricsMs,
      tempUnit: 'F',
      compactRows: ['cpu', 'net'],
      warnSession: [75, 95],
      warnWeekly: [],
      workDir: '',
    });
    const folder = process.platform === 'win32' ? 'D:\\Projects' : '/home/me/Projects';
    expect(cleanSettings({ workDir: ` ${folder} ` }).workDir).toBe(folder);
  });

  it('saves a change on top of what is stored', () => {
    expect(loadSettings()).toEqual(DEFAULT_SETTINGS);
    updateSettings({ protectedPaths: ['D:\\Photos'] });
    updateSettings({ motion: false });
    expect(loadSettings()).toMatchObject({ motion: false, protectedPaths: ['D:\\Photos'] });
    expect(JSON.parse(readFileSync(join(home, 'settings.json'), 'utf8'))).toMatchObject({ motion: false });
  });
});

describe('background photo', () => {
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
  const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

  it('recognises images by their bytes, not their name', () => {
    expect(imageType(png)).toBe('png');
    expect(imageType(jpg)).toBe('jpg');
    expect(imageType(Buffer.from('RIFF\0\0\0\0WEBPVP8 '))).toBe('webp');
    expect(imageType(Buffer.from('<svg onload=alert(1)>'))).toBeNull();
  });

  it('replaces the old photo and can remove it', () => {
    expect(saveBackground(jpg)).toBe(true);
    expect(saveBackground(png)).toBe(true);
    expect(findBackground()?.contentType).toBe('image/png');
    expect(existsSync(join(home, 'background.jpg'))).toBe(false);
    expect(saveBackground(Buffer.from('not an image'))).toBe(false);
    removeBackground();
    expect(findBackground()).toBeNull();
  });
});
