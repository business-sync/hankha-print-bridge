import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

/**
 * Nothing parses the Windows installer scripts before they ship: PowerShell exists on no build
 * machine here, and the one thing `install.ps1` does that can only be exercised on a till is
 * `Register-ScheduledTask`. These assertions are the cheap half of that gap. They pin the two
 * shapes whose absence turned 1.3.0 → 1.12.0 into a Setup that failed on every current Windows
 * build, so neither can come back through a well-meaning edit.
 */
describe('installer/windows/install.ps1', () => {
  const script = readFileSync(new URL('../installer/windows/install.ps1', import.meta.url), 'utf8');
  // Comments are free to name the trap; only code lines are held to the rule.
  const code = script
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');

  it('never asks Task Scheduler for a "forever" RepetitionDuration', () => {
    // [TimeSpan]::MaxValue serialises to P99999999DT23H59M59S, which Windows 10/11 reject at
    // registration (0x80041318) — and the rejection takes the whole task with it. Leaving the
    // duration out is what "indefinitely" looks like in the task XML.
    assert.doesNotMatch(code, /RepetitionDuration/);
    assert.doesNotMatch(code, /TimeSpan\]::MaxValue/);
  });

  it('keeps the 5-minute heartbeat, and registers without it when Windows refuses it', () => {
    assert.match(code, /-RepetitionInterval \(New-TimeSpan -Minutes 5\)/);

    const attempts = code.match(/Register-ScheduledTask /g) ?? [];
    assert.equal(attempts.length, 2, 'one attempt with the heartbeat, one fallback without');

    const warning = code.indexOf('Could not register the 5-minute self-heal trigger');
    assert.ok(warning > -1, 'the fallback must say what was lost');
    assert.ok(code.indexOf('Register-ScheduledTask ') < warning, 'the attempt comes before the warning');
    assert.ok(code.lastIndexOf('Register-ScheduledTask ') > warning, 'the fallback comes after it');
    assert.match(code, /-Trigger \(New-ScheduledTaskTrigger -AtStartup\)/);
  });
});
