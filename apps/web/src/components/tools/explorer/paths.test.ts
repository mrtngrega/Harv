import { describe, expect, it } from 'vitest';
import { baseName, dirOf, driveName, driveOf, pathParts } from './paths.ts';

const linuxDrives = [
  { path: '/', label: 'File System', total: 0, free: 0 },
  { path: '/home', label: 'Home', total: 0, free: 0 },
  { path: '/run/media/me/USB', label: 'USB', total: 0, free: 0 },
];

describe('explorer paths on Windows and Linux', () => {
  it('names files and their folders', () => {
    expect(baseName('C:\\Users\\me\\notes.txt')).toBe('notes.txt');
    expect(baseName('/home/me/notes.txt')).toBe('notes.txt');
    expect(baseName('/home/me/')).toBe('me');
    expect(baseName('/')).toBe('/');
    expect(dirOf('C:\\Users\\me\\notes.txt')).toBe('C:\\Users\\me');
    expect(dirOf('C:\\notes.txt')).toBe('C:\\');
    expect(dirOf('/home/me/notes.txt')).toBe('/home/me');
    expect(dirOf('/notes.txt')).toBe('/');
  });

  it('breaks a path into clickable folders', () => {
    expect(pathParts('C:\\Users\\me').map((p) => p.loc)).toEqual(['C:\\', 'C:\\Users', 'C:\\Users\\me']);
    expect(pathParts('/home/me').map((p) => p.loc)).toEqual(['/', '/home', '/home/me']);
    expect(pathParts('/').map((p) => p.loc)).toEqual(['/']);
  });

  it('knows which drive a path is on', () => {
    expect(driveOf('C:\\Users\\x', [])).toBe('c:');
    expect(driveOf('/home/me/a.txt', linuxDrives)).toBe('/home');
    expect(driveOf('/run/media/me/USB/a.txt', linuxDrives)).toBe('/run/media/me/USB');
    expect(driveOf('/etc/hosts', linuxDrives)).toBe('/');
    expect(driveOf('/homework/a', linuxDrives)).toBe('/');
    expect(driveName({ path: 'C:\\', label: 'Local Disk', total: 0, free: 0 })).toBe('Local Disk (C:)');
    expect(driveName(linuxDrives[1]!)).toBe('Home');
  });
});
