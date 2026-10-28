import { describe, expect, it } from 'vitest';
import { baseName, dirOf, driveName, driveOf, linuxParts, pathParts } from './paths.ts';

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

  it('starts the Linux breadcrumb at Home inside the home folder, else at Root, like Dolphin', () => {
    expect(linuxParts('/home/me/Code/Harv', '/home/me')).toEqual([
      { label: 'Home', loc: '/home/me' },
      { label: 'Code', loc: '/home/me/Code' },
      { label: 'Harv', loc: '/home/me/Code/Harv' },
    ]);
    expect(linuxParts('/home/me', '/home/me')).toEqual([{ label: 'Home', loc: '/home/me' }]);
    expect(linuxParts('/home/meg', '/home/me').map((p) => p.label)).toEqual(['Root', 'home', 'meg']);
    expect(linuxParts('/', '/home/me')).toEqual([{ label: 'Root', loc: '/' }]);
    const trash = '/home/me/.local/share/Trash/files';
    expect(linuxParts(`${trash}/old`, '/home/me', trash).map((p) => p.label)).toEqual(['Trash', 'old']);
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
