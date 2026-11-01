import { describe, expect, it } from 'vitest';
import { unitText } from './bootStart.ts';

describe('start at boot', () => {
  it('runs harv.sh start without a browser, stops it cleanly and starts with the user manager', () => {
    const unit = unitText('/home/u/Code/Harv/scripts/harv.sh');
    expect(unit).toContain('ExecStart=/usr/bin/bash /home/u/Code/Harv/scripts/harv.sh start --no-browser');
    expect(unit).toContain('ExecStop=/usr/bin/bash /home/u/Code/Harv/scripts/harv.sh stop');
    // harv.sh detaches Harv and returns: a oneshot that stays active keeps Harv in the unit.
    expect(unit).toContain('Type=oneshot');
    expect(unit).toContain('RemainAfterExit=yes');
    expect(unit).toContain('WantedBy=default.target');
  });
});
