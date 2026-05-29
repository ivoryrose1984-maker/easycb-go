// Competition-adjusted profit threshold multiplier.
// Lower multiplier = more aggressive (accept thinner spreads).
// Higher multiplier = conservative (require larger spreads).
//
// Calibrated for UTC time vs observed Base MEV competition patterns.
// Adjust after dry-run data confirms the pattern.

interface Window {
  utcHourStart: number;
  utcHourEnd:   number;
  multiplier:   number;
  label:        string;
}

const WINDOWS: Window[] = [
  // US/EU market open — peak competition
  { utcHourStart: 13, utcHourEnd: 16, multiplier: 1.5,  label: 'us-market-open' },
  // EU open
  { utcHourStart:  7, utcHourEnd:  9, multiplier: 1.3,  label: 'eu-open' },
  // Asian session — medium competition
  { utcHourStart:  0, utcHourEnd:  4, multiplier: 0.85, label: 'asian-session' },
  // Dead hours — lowest competition
  { utcHourStart:  4, utcHourEnd:  7, multiplier: 0.7,  label: 'dead-hours' },
];

const DEFAULT_MULTIPLIER = 1.0;

export interface CompetitionWindow {
  multiplier: number;
  label:      string;
  utcHour:    number;
}

export function getCompetitionWindow(): CompetitionWindow {
  const utcHour = new Date().getUTCHours();

  for (const w of WINDOWS) {
    if (utcHour >= w.utcHourStart && utcHour < w.utcHourEnd) {
      return { multiplier: w.multiplier, label: w.label, utcHour };
    }
  }
  return { multiplier: DEFAULT_MULTIPLIER, label: 'normal', utcHour };
}

// Adjust a base threshold by competition window
export function adjustedThreshold(baseThresholdBps: number): number {
  return baseThresholdBps * getCompetitionWindow().multiplier;
}
