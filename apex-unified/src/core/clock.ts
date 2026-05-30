export interface CompetitionWindow {
  multiplier: number;
  label:      string;
  utcHour:    number;
}

const WINDOWS = [
  { utcHourStart: 13, utcHourEnd: 16, multiplier: 1.5,  label: 'us-market-open' },
  { utcHourStart:  7, utcHourEnd:  9, multiplier: 1.3,  label: 'eu-open'         },
  { utcHourStart:  0, utcHourEnd:  4, multiplier: 0.85, label: 'asian-session'   },
  { utcHourStart:  4, utcHourEnd:  7, multiplier: 0.7,  label: 'dead-hours'      },
];

export function getCompetitionWindow(): CompetitionWindow {
  const utcHour = new Date().getUTCHours();
  for (const w of WINDOWS) {
    if (utcHour >= w.utcHourStart && utcHour < w.utcHourEnd) {
      return { multiplier: w.multiplier, label: w.label, utcHour };
    }
  }
  return { multiplier: 1.0, label: 'normal', utcHour };
}

export function adjustedThreshold(baseThresholdBps: number): number {
  return baseThresholdBps * getCompetitionWindow().multiplier;
}
