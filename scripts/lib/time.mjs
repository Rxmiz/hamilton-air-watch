// Time helpers for America/Toronto without external deps.
const TZ = 'America/Toronto';
const fmt = new Intl.DateTimeFormat('en-CA', {
  timeZone: TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
});

export function torontoDateParts(date) {
  const p = Object.fromEntries(fmt.formatToParts(date).map(x => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// Local Toronto wall-clock hour -> UTC ISO string "YYYY-MM-DDTHH:00Z"
export function torontoWallClockToUtc(y, m, d, h) {
  const guess = Date.UTC(y, m - 1, d, h);
  // offset = wallclock(guess) - guess; iterate twice to settle across DST edges
  let t = guess;
  for (let i = 0; i < 2; i++) {
    const wc = torontoDateParts(new Date(t));
    const [date, time] = wc.split('T');
    const [yy, mm, dd] = date.split('-').map(Number);
    const wcMs = Date.UTC(yy, mm - 1, dd, +time.slice(0, 2), +time.slice(3, 5));
    t = guess - (wcMs - t);
  }
  return new Date(t).toISOString().slice(0, 13) + ':00Z';
}
