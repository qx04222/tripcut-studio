import { beforeEach, expect, it, vi } from 'vitest';
import { createTestApiMock } from './testApiMock';
vi.mock('../api', async () => createTestApiMock());
import { getSettings, setSetting } from '../api';
import { __resetPlayerPrefsForTests, getPlayerPrefs, loadPlayerPrefs, writeScrubberView } from './playerPrefs';
beforeEach(() => { __resetPlayerPrefsForTests(); vi.clearAllMocks(); });
it('006: late settings hydration cannot overwrite a view chosen in this session', async () => {
  let finish!: (settings: Record<string, string>) => void;
  vi.mocked(getSettings).mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const load = loadPlayerPrefs();
  await writeScrubberView('zoom');
  finish({ 'ui.player.scrubber_view': 'full' }); await load;
  expect(getPlayerPrefs().scrubberView).toBe('zoom');
  expect(setSetting).toHaveBeenCalledWith('ui.player.scrubber_view', 'zoom');
});
it('006: stored full/zoom round-trip and unknown preference defaults to full', async () => {
  for (const value of ['zoom', 'full', 'unknown']) {
    __resetPlayerPrefsForTests();
    vi.mocked(getSettings).mockResolvedValue({ 'ui.player.scrubber_view': value });
    await loadPlayerPrefs();
    expect(getPlayerPrefs().scrubberView).toBe(value === 'zoom' ? 'zoom' : 'full');
  }
});
