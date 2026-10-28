const daySeconds = 24 * 60 * 60;

function secondsAfterMidnight(value: string) {
  if (!/^\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/.test(value)) {
    throw new Error("Schedule times must be valid local clock times.");
  }
  const [hours, minutes, seconds = 0] = value.split(":").map(Number);
  if (hours === undefined || minutes === undefined || hours > 23 || minutes > 59 || seconds >= 60) {
    throw new Error("Schedule times must be valid local clock times.");
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function clockTime(seconds: number) {
  const withinDay = ((seconds % daySeconds) + daySeconds) % daySeconds;
  return `${String(Math.floor(withinDay / 3600)).padStart(2, "0")}:${String(Math.floor(withinDay % 3600 / 60)).padStart(2, "0")}`;
}

/** Validate one local sleep cycle; this does not use the browser/server timezone. */
export function getTemperatureSchedule(profile: {
  bedTime: string;
  wakeupTime: string;
  finalStageStartTime?: string | null;
}) {
  const bed = secondsAfterMidnight(profile.bedTime);
  let wake = secondsAfterMidnight(profile.wakeupTime);
  if (wake <= bed) wake += daySeconds;
  const duration = wake - bed;
  if (duration < 4 * 3600) {
    throw new Error("Sleep duration must be at least four hours.");
  }
  const mid = bed + 3600;
  let final = wake - 2 * 3600;
  if (profile.finalStageStartTime != null) {
    final = secondsAfterMidnight(profile.finalStageStartTime);
    if (final < bed) final += daySeconds;
  }
  if (final < mid || final >= wake) {
    throw new Error("Final-stage start must be at or after the mid-stage start and before wake-up.");
  }
  return {
    durationMinutes: duration / 60,
    midStageTime: clockTime(mid),
    finalStageTime: clockTime(final),
  };
}
