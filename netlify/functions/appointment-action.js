const CENTRAL_TIME_ZONE = "America/Chicago";
const DEFAULT_SLOT_MINUTES = 60;
const SLOT_INTERVAL_MINUTES = 30;
const MAX_RETURNED_SLOTS = 3;
const BUSINESS_START_HOUR = 9;
const BUSINESS_END_HOUR = 18;

function buildAssistantControl(status) {
  const controls = {
    needs_more_info: {
      mayConfirmSuccess: false,
      successState: false,
      nextStep: "collect_more_information",
      instruction:
        "Ask the caller for the missing information requested in messageForAssistant. Do not confirm an appointment outcome."
    },
    needs_slot_selection: {
      mayConfirmSuccess: false,
      successState: false,
      nextStep: "offer_available_slots",
      instruction:
        "Offer the returned slot options to the caller. If the caller accepts one, call appointment_action again with action=book and the exact selected start_time as requestedStartTime. Do not say the callback is scheduled yet."
    },
    conflict: {
      mayConfirmSuccess: false,
      successState: false,
      nextStep: "ask_for_new_callback_window",
      instruction:
        "Tell the caller that window is not available and ask for another one-hour callback window. Do not confirm an appointment outcome."
    },
    possible_duplicate: {
      mayConfirmSuccess: false,
      successState: false,
      nextStep: "confirm_existing_callback_before_duplicate_booking",
      instruction:
        "Tell the caller there may already be a future callback. Do not create another callback or confirm success unless the caller clearly confirms what they want to do next."
    },
    single_match_found: {
      mayConfirmSuccess: false,
      successState: false,
      nextStep: "confirm_matched_appointment",
      instruction:
        "Use messageForAssistant to ask whether this is the appointment the caller means. If the caller confirms a reschedule, call appointment_action again with action=reschedule, appointmentId, nylasEventId if available, and the caller's requestedCallbackTime in natural language. Do not generate ISO dates. Use requestedStartTime only if it was copied from a backend-returned slot. If the caller confirms a cancel, call appointment_action again with action=cancel and appointmentId. Do not say the appointment was moved or cancelled yet."
    },
    multiple_matches_found: {
      mayConfirmSuccess: false,
      successState: false,
      nextStep: "ask_caller_to_choose_appointment",
      instruction:
        "Ask which matched appointment the caller means. Do not change or confirm any appointment until one appointment is clearly selected."
    },
    not_found: {
      mayConfirmSuccess: false,
      successState: false,
      nextStep: "collect_more_lookup_information",
      instruction:
        "Ask for more identifying information such as property address, callback number, or original appointment time. Do not confirm an appointment outcome."
    },
    booked: {
      mayConfirmSuccess: true,
      successState: true,
      nextStep: "confirm_booking",
      instruction:
        "The backend created the calendar event. You may confirm the callback is scheduled using messageForAssistant."
    },
    rescheduled: {
      mayConfirmSuccess: true,
      successState: true,
      nextStep: "confirm_reschedule",
      instruction:
        "The backend moved the calendar event. You may confirm the callback has been rescheduled using messageForAssistant."
    },
    cancelled: {
      mayConfirmSuccess: true,
      successState: true,
      nextStep: "confirm_cancel",
      instruction:
        "The backend cancelled the callback. You may confirm the callback has been cancelled using messageForAssistant."
    },
    error: {
      mayConfirmSuccess: false,
      successState: false,
      nextStep: "fallback_collect_info_for_team",
      instruction:
        "Tell the caller there was trouble checking the appointment system. Collect the request for the team. Do not confirm an appointment outcome."
    }
  };

  return (
    controls[status] || {
      mayConfirmSuccess: false,
      successState: false,
      nextStep: "unknown_backend_status",
      instruction:
        "Follow messageForAssistant if present, but do not confirm any appointment outcome unless the backend status is booked, rescheduled, or cancelled."
    }
  );
}

function jsonResponse(statusCode, body) {
  const safeBody = body && typeof body === "object" ? body : {};
  const status = safeBody.status || "unknown";

  return {
    statusCode,
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...safeBody,
      assistantControl: safeBody.assistantControl || buildAssistantControl(status)
    })
  };
}

function getRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function verifyRequest(event) {
  if (event.httpMethod !== "POST") {
    return jsonResponse(405, {
      status: "error",
      messageForAssistant: "This endpoint only accepts POST requests."
    });
  }

  const expectedSecret = getRequiredEnv("API_SHARED_SECRET");
  const providedSecret =
    event.headers["x-api-key"] ||
    event.headers["X-API-Key"] ||
    event.headers["X-API-KEY"];

  if (!providedSecret || providedSecret !== expectedSecret) {
    return jsonResponse(401, {
      status: "error",
      messageForAssistant: "Unauthorized request."
    });
  }

  return null;
}

function parseBody(event) {
  if (!event.body) return {};

  try {
    return JSON.parse(event.body);
  } catch (error) {
    throw new Error("Invalid JSON body.");
  }
}

function getCentralDateParts(date) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false
  });

  const parts = formatter.formatToParts(date);
  const out = {};
  for (const part of parts) {
    out[part.type] = part.value;
  }

  return {
    year: Number(out.year),
    month: Number(out.month),
    day: Number(out.day),
    weekday: out.weekday,
    hour: Number(out.hour),
    minute: Number(out.minute),
    second: Number(out.second)
  };
}

function centralDateToUtcDate(year, month, day, hour, minute) {
  const utcGuess = new Date(Date.UTC(year, month - 1, day, hour, minute, 0));
  const centralParts = getCentralDateParts(utcGuess);

  const desiredAsUtc = Date.UTC(year, month - 1, day, hour, minute, 0);
  const actualAsUtc = Date.UTC(
    centralParts.year,
    centralParts.month - 1,
    centralParts.day,
    centralParts.hour,
    centralParts.minute,
    centralParts.second || 0
  );

  const offsetMs = actualAsUtc - desiredAsUtc;
  return new Date(utcGuess.getTime() - offsetMs);
}

function addDaysCentral(date, days) {
  const parts = getCentralDateParts(date);
  const noonUtc = centralDateToUtcDate(parts.year, parts.month, parts.day, 12, 0);
  noonUtc.setUTCDate(noonUtc.getUTCDate() + days);
  const nextParts = getCentralDateParts(noonUtc);
  return {
    year: nextParts.year,
    month: nextParts.month,
    day: nextParts.day
  };
}

function weekdayIndexFromCentralDate(year, month, day) {
  const d = centralDateToUtcDate(year, month, day, 12, 0);
  const weekday = getCentralDateParts(d).weekday;
  const map = {
    Sun: 0,
    Mon: 1,
    Tue: 2,
    Wed: 3,
    Thu: 4,
    Fri: 5,
    Sat: 6
  };
  return map[weekday];
}

function nextBusinessDayCentral(fromDate, minDaysAhead = 0) {
  for (let i = minDaysAhead; i <= minDaysAhead + 14; i++) {
    const candidate = addDaysCentral(fromDate, i);
    const weekday = weekdayIndexFromCentralDate(
      candidate.year,
      candidate.month,
      candidate.day
    );

    if (weekday >= 1 && weekday <= 5) {
      return candidate;
    }
  }

  const fallback = addDaysCentral(fromDate, minDaysAhead || 1);
  return fallback;
}

function findRequestedDate(requestedText, now) {
  const text = String(requestedText || "").toLowerCase();

  if (text.includes("tomorrow")) {
    return addDaysCentral(now, 1);
  }

  const sameDayPhrases = [
    "today",
    "same day",
    "this morning",
    "this afternoon",
    "this evening",
    "tonight"
  ];

  for (const phrase of sameDayPhrases) {
    if (text.includes(phrase)) {
      return addDaysCentral(now, 0);
    }
  }

  const weekdayNames = [
    ["sunday", 0],
    ["monday", 1],
    ["tuesday", 2],
    ["wednesday", 3],
    ["thursday", 4],
    ["friday", 5],
    ["saturday", 6]
  ];

  for (const [name, targetIndex] of weekdayNames) {
    if (text.includes(name)) {
      const todayParts = getCentralDateParts(now);
      const todayIndex = weekdayIndexFromCentralDate(
        todayParts.year,
        todayParts.month,
        todayParts.day
      );

      let daysAhead = targetIndex - todayIndex;
      if (daysAhead <= 0) daysAhead += 7;

      return addDaysCentral(now, daysAhead);
    }
  }

  // No recognized date signal. Do not invent a date; the caller
  // must be asked which day they mean.
  return null;
}

function parseHourValue(rawHour, meridiem) {
  let hour = Number(rawHour);
  if (!Number.isFinite(hour)) return null;

  const mer = String(meridiem || "").toLowerCase();

  if (mer === "pm" && hour < 12) hour += 12;
  if (mer === "am" && hour === 12) hour = 0;

  return hour;
}

function normalizeSpokenTimeWords(input) {
  let text = String(input || "").toLowerCase();

  const replacements = [
    ["twelve thirty", "12:30"],
    ["eleven thirty", "11:30"],
    ["ten thirty", "10:30"],
    ["nine thirty", "9:30"],
    ["eight thirty", "8:30"],
    ["seven thirty", "7:30"],
    ["six thirty", "6:30"],
    ["five thirty", "5:30"],
    ["four thirty", "4:30"],
    ["three thirty", "3:30"],
    ["two thirty", "2:30"],
    ["one thirty", "1:30"],
    ["noon", "12 pm"],
    ["midday", "12 pm"],
    ["twelve", "12"],
    ["eleven", "11"],
    ["ten", "10"],
    ["nine", "9"],
    ["eight", "8"],
    ["seven", "7"],
    ["six", "6"],
    ["five", "5"],
    ["four", "4"],
    ["three", "3"],
    ["two", "2"],
    ["one", "1"]
  ];

  for (const [word, value] of replacements) {
    text = text.replace(new RegExp("\\b" + word + "\\b", "g"), value);
  }

  return text;
}

function inferBusinessHour(rawHour, meridiem, originalText) {
  if (meridiem) return parseHourValue(rawHour, meridiem);

  const hour = Number(rawHour);
  if (!Number.isFinite(hour)) return null;

  const text = String(originalText || "").toLowerCase();

  // Word-boundary matches only. text.includes("am") wrongly matched
  // the "am" inside words like "same", which broke PM inference for
  // phrases like "four o'clock same day".
  const saysMorning = /\bmorning\b/.test(text) || /\bam\b/.test(text);

  if (hour >= 1 && hour <= 6 && !saysMorning) {
    return hour + 12;
  }

  return hour;
}

function parseRequestedWindow(requestedText, now) {
  const originalText = String(requestedText || "").toLowerCase();
  const text = normalizeSpokenTimeWords(originalText);
  const dateParts = findRequestedDate(text, now);

  let startHour = BUSINESS_START_HOUR;
  let endHour = BUSINESS_END_HOUR;
  let startMinute = 0;
  let endMinute = 0;
  let hasRecognizedTimeSignal = false;

  const rangeMatch = text.match(
    /(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*(?:-|to|until|through)\s*(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/
  );

  if (rangeMatch) {
    const firstMeridiem = rangeMatch[3] || rangeMatch[6] || "";
    const secondMeridiem = rangeMatch[6] || rangeMatch[3] || "";

    const parsedStartHour = inferBusinessHour(rangeMatch[1], firstMeridiem, text);
    const parsedEndHour = inferBusinessHour(rangeMatch[4], secondMeridiem, text);

    if (parsedStartHour !== null && parsedEndHour !== null) {
      hasRecognizedTimeSignal = true;
      startHour = parsedStartHour;
      endHour = parsedEndHour;
      startMinute = rangeMatch[2] ? Number(rangeMatch[2]) : 0;
      endMinute = rangeMatch[5] ? Number(rangeMatch[5]) : 0;

      if (endHour <= startHour) {
        endHour += 12;
      }
    }
  } else {
    const singleTimeMatch = text.match(/(\d{1,2})(?::(\d{2}))?\s*(am|pm)?/);

    if (singleTimeMatch) {
      const parsedHour = inferBusinessHour(singleTimeMatch[1], singleTimeMatch[3] || "", text);

      if (parsedHour !== null) {
        hasRecognizedTimeSignal = true;
        startHour = parsedHour;
        startMinute = singleTimeMatch[2] ? Number(singleTimeMatch[2]) : 0;
        endHour = startHour + 1;
        endMinute = startMinute;
      }
    } else if (text.includes("morning")) {
      hasRecognizedTimeSignal = true;
      startHour = 9;
      endHour = 12;
    } else if (text.includes("afternoon")) {
      hasRecognizedTimeSignal = true;
      startHour = 12;
      endHour = 17;
    } else if (text.includes("later")) {
      hasRecognizedTimeSignal = true;
      startHour = 14;
      endHour = 18;
    }
  }

  if (!hasRecognizedTimeSignal) {
    console.warn("Rejecting ambiguous requestedCallbackTime with no recognized time signal", {
      requestedText
    });
    return null;
  }

  if (!dateParts) {
    // A time was given but no recognizable day. Do not invent a
    // date; the caller must be asked which day they mean.
    console.warn("Rejecting requestedCallbackTime with no recognized date signal", {
      requestedText
    });
    return null;
  }

  if (startHour < BUSINESS_START_HOUR || startHour >= BUSINESS_END_HOUR) {
    // Outside business hours. Reject instead of silently moving the
    // caller's stated time; the caller must be offered valid hours.
    console.warn("Rejecting requestedCallbackTime outside business hours", {
      requestedText,
      startHour
    });
    return null;
  }

  endHour = Math.min(endHour, BUSINESS_END_HOUR);

  if (endHour <= startHour && endMinute <= startMinute) {
    endHour = Math.min(startHour + 1, BUSINESS_END_HOUR);
    endMinute = startMinute;
  }

  const start = centralDateToUtcDate(
    dateParts.year,
    dateParts.month,
    dateParts.day,
    startHour,
    startMinute
  );

  const end = centralDateToUtcDate(
    dateParts.year,
    dateParts.month,
    dateParts.day,
    endHour,
    endMinute
  );

  return { start, end };
}

function rangesOverlap(aStartMs, aEndMs, bStartMs, bEndMs) {
  return aStartMs < bEndMs && aEndMs > bStartMs;
}

function extractBusySlots(nylasBody) {
  const data = Array.isArray(nylasBody?.data) ? nylasBody.data : [];
  const busy = [];

  for (const schedule of data) {
    const timeSlots = Array.isArray(schedule?.time_slots)
      ? schedule.time_slots
      : [];

    for (const slot of timeSlots) {
      const startSeconds = Number(slot.start_time);
      const endSeconds = Number(slot.end_time);

      if (Number.isFinite(startSeconds) && Number.isFinite(endSeconds)) {
        busy.push({
          startMs: startSeconds * 1000,
          endMs: endSeconds * 1000
        });
      }
    }
  }

  return busy;
}

function formatCentralIso(date) {
  const parts = getCentralDateParts(date);
  const offset = getCentralOffset(date);
  return `${parts.year}-${String(parts.month).padStart(2, "0")}-${String(
    parts.day
  ).padStart(2, "0")}T${String(parts.hour).padStart(2, "0")}:${String(
    parts.minute
  ).padStart(2, "0")}:00${offset}`;
}

function getCentralOffset(date) {
  const centralParts = getCentralDateParts(date);
  const centralAsUtc = Date.UTC(
    centralParts.year,
    centralParts.month - 1,
    centralParts.day,
    centralParts.hour,
    centralParts.minute,
    centralParts.second || 0
  );

  const offsetMinutes = Math.round((centralAsUtc - date.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  const hours = Math.floor(abs / 60);
  const minutes = abs % 60;

  return `${sign}${String(hours).padStart(2, "0")}:${String(minutes).padStart(
    2,
    "0"
  )}`;
}

function spokenCentralTime(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: CENTRAL_TIME_ZONE,
    weekday: "long",
    hour: "numeric",
    minute: "2-digit",
    hour12: true
  })
    .format(date)
    .replace(":00", "")
    .replace(" AM", " in the morning")
    .replace(" PM", " in the afternoon");
}

function generateAvailableSlots(windowStart, windowEnd, busySlots) {
  const slots = [];
  let cursor = new Date(windowStart);

  const intervalMs = SLOT_INTERVAL_MINUTES * 60 * 1000;
  const durationMs = DEFAULT_SLOT_MINUTES * 60 * 1000;

  while (cursor.getTime() + durationMs <= windowEnd.getTime()) {
    const slotStartMs = cursor.getTime();
    const slotEndMs = slotStartMs + durationMs;

    const conflicts = busySlots.some((busy) =>
      rangesOverlap(slotStartMs, slotEndMs, busy.startMs, busy.endMs)
    );

    if (!conflicts) {
      const startDate = new Date(slotStartMs);
      slots.push({
        start_time: formatCentralIso(startDate),
        end_time: formatCentralIso(new Date(slotEndMs)),
        spoken_time: spokenCentralTime(startDate) + " Central"
      });
    }

    if (slots.length >= MAX_RETURNED_SLOTS) break;
    cursor = new Date(cursor.getTime() + intervalMs);
  }

  return slots;
}

async function callNylasFreeBusy(start, end) {
  const nylasApiKey = getRequiredEnv("NYLAS_API_KEY");
  const nylasGrantId = getRequiredEnv("NYLAS_GRANT_ID");
  const calendarEmail = getRequiredEnv("CALENDAR_EMAIL");

  const url = `https://api.us.nylas.com/v3/grants/${encodeURIComponent(
    nylasGrantId
  )}/calendars/free-busy`;

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${nylasApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      start_time: Math.floor(start.getTime() / 1000),
      end_time: Math.floor(end.getTime() / 1000),
      emails: [calendarEmail],
      tentative_as_busy: true
    })
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      body
    };
  }

  const data = Array.isArray(body?.data) ? body.data : [];
  const firstError = data.find((item) => item?.error);

  if (firstError) {
    return {
      ok: false,
      statusCode: 502,
      body
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    body
  };
}

async function handleAvailability(payload) {
  const requestedCallbackTime = payload.requestedCallbackTime || "";
  const now = new Date();

  const requestedWindow = parseRequestedWindow(requestedCallbackTime, now);

  if (
    !requestedWindow ||
    !requestedWindow.start ||
    !requestedWindow.end ||
    requestedWindow.end <= requestedWindow.start
  ) {
    return jsonResponse(200, {
      status: "needs_more_info",
      messageForAssistant:
        "Ask the caller for a specific day and a one-hour callback window during Monday through Friday, 9:00 AM to 6:00 PM Central."
    });
  }

  const nylasResult = await callNylasFreeBusy(
    requestedWindow.start,
    requestedWindow.end
  );

  if (!nylasResult.ok) {
    console.error("Nylas Free/Busy error", {
      statusCode: nylasResult.statusCode,
      body: nylasResult.body
    });

    return jsonResponse(502, {
      status: "error",
      messageForAssistant:
        "I’m having trouble checking the calendar right now. Let me collect the preferred callback time and have the team follow up.",
      error: "nylas_free_busy_failed"
    });
  }

  const busySlots = extractBusySlots(nylasResult.body);
  const slots = generateAvailableSlots(
    requestedWindow.start,
    requestedWindow.end,
    busySlots
  );

  if (slots.length === 0) {
    return jsonResponse(200, {
      status: "conflict",
      messageForAssistant:
        "That window is not showing as available. Ask the caller for another one-hour window during Monday through Friday, 9:00 AM to 6:00 PM Central.",
      requestedWindow: {
        start_time: formatCentralIso(requestedWindow.start),
        end_time: formatCentralIso(requestedWindow.end)
      }
    });
  }

  return jsonResponse(200, {
    status: "needs_slot_selection",
    messageForAssistant: "Offer these times to the caller.",
    requestedWindow: {
      start_time: formatCentralIso(requestedWindow.start),
      end_time: formatCentralIso(requestedWindow.end)
    },
    slots
  });
}

function cleanValue(value, fallback = "") {
  if (value === null || value === undefined) return fallback;
  const text = String(value).trim();

  if (!text) return fallback;

  // Treat unresolved Telnyx/template placeholders as missing values.
  if (/^\{\{[^}]+\}\}$/.test(text)) {
    return fallback;
  }

  return text;
}

function buildCalendarTitle(payload) {
  const callerName = cleanValue(payload.callerName, "Unknown Caller");
  const propertyAddress = cleanValue(payload.propertyAddress, "Address Not Provided");
  return `Seller Call - ${callerName} - ${propertyAddress}`;
}

function normalizePhoneDigits(value) {
  return cleanValue(value).replace(/\D/g, "");
}

function normalizeDuplicateText(value) {
  return cleanValue(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\b(street|st)\b/g, "st")
    .replace(/\b(avenue|ave)\b/g, "ave")
    .replace(/\b(road|rd)\b/g, "rd")
    .replace(/\b(drive|dr)\b/g, "dr")
    .replace(/\b(lane|ln)\b/g, "ln")
    .replace(/\b(court|ct)\b/g, "ct")
    .replace(/\b(circle|cir)\b/g, "cir")
    .replace(/\b(terrace|ter)\b/g, "ter")
    .replace(/\b(place|pl)\b/g, "pl")
    .replace(/\s+/g, " ")
    .trim();
}

function duplicateTextMatches(a, b) {
  const first = normalizeDuplicateText(a);
  const second = normalizeDuplicateText(b);

  if (!first || !second) return false;
  return first === second || first.includes(second) || second.includes(first);
}

function getEventStartDate(event) {
  const when = event && event.when ? event.when : {};
  const rawStart =
    when.start_time ||
    when.startTime ||
    when.start ||
    when.date ||
    when.start_date ||
    null;

  if (!rawStart) return null;

  if (typeof rawStart === "number") {
    return new Date(rawStart * 1000);
  }

  if (/^\d+$/.test(String(rawStart))) {
    return new Date(Number(rawStart) * 1000);
  }

  const parsed = new Date(rawStart);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function getEventEndDate(event) {
  const when = event && event.when ? event.when : {};
  const rawEnd =
    when.end_time ||
    when.endTime ||
    when.end ||
    when.date ||
    when.end_date ||
    null;

  if (!rawEnd) return null;

  if (typeof rawEnd === "number") {
    return new Date(rawEnd * 1000);
  }

  if (/^\d+$/.test(String(rawEnd))) {
    return new Date(Number(rawEnd) * 1000);
  }

  const parsed = new Date(rawEnd);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed;
}

function summarizeDuplicateEvent(event) {
  const startDate = getEventStartDate(event);
  const title = cleanValue(event.title, "existing seller callback");
  const whenText = startDate ? spokenCentralTime(startDate) + " Central" : "a future time";
  return `${title} at ${whenText}`;
}

function isPossibleDuplicateEvent(event, payload) {
  const metadata = event && event.metadata ? event.metadata : {};

  if (
    cleanValue(metadata.recast_booking) !== "1" ||
    cleanValue(metadata.appointment_type) !== "seller_callback"
  ) {
    return false;
  }

  const status = cleanValue(metadata.status).toLowerCase();
  if (status === "cancelled" || status === "completed" || status === "no_show") {
    return false;
  }

  const payloadPhone = normalizePhoneDigits(payload.callbackNumber);
  const eventPhone = normalizePhoneDigits(metadata.callback_number);

  if (payloadPhone && eventPhone) {
    const payloadLast10 = payloadPhone.slice(-10);
    const eventLast10 = eventPhone.slice(-10);
    if (payloadLast10 && eventLast10 && payloadLast10 === eventLast10) {
      return true;
    }
  }

  const payloadAddress = payload.propertyAddress;
  const eventAddress = metadata.property_address;

  if (duplicateTextMatches(payloadAddress, eventAddress)) {
    return true;
  }

  return false;
}

async function findFutureDuplicateAppointment(payload, selectedStart) {
  const nylasApiKey = getRequiredEnv("NYLAS_API_KEY");
  const nylasGrantId = getRequiredEnv("NYLAS_GRANT_ID");
  const calendarId = process.env.CALENDAR_ID || "primary";

  const now = new Date();
  const startTime = Math.floor(now.getTime() / 1000);
  const endTime = Math.floor(addMinutes(selectedStart, 60 * 24 * 90).getTime() / 1000);

  let pageToken = "";
  let checkedEvents = 0;

  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({
      calendar_id: calendarId,
      start: String(startTime),
      end: String(endTime),
      limit: "50",
      select: "id,title,when,metadata,status,busy"
    });

    if (pageToken) {
      params.set("page_token", pageToken);
    }

    const url =
      `https://api.us.nylas.com/v3/grants/${encodeURIComponent(nylasGrantId)}/events?` +
      params.toString();

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${nylasApiKey}`
      }
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        body
      };
    }

    const events = Array.isArray(body.data) ? body.data : [];

    for (const event of events) {
      checkedEvents += 1;

      const eventEnd = getEventEndDate(event);
      if (eventEnd && eventEnd < now) {
        continue;
      }

      if (isPossibleDuplicateEvent(event, payload)) {
        return {
          ok: true,
          duplicateFound: true,
          event,
          checkedEvents
        };
      }
    }

    pageToken = cleanValue(body.next_cursor);
    if (!pageToken) break;
  }

  return {
    ok: true,
    duplicateFound: false,
    checkedEvents
  };
}


function appointmentLookupMatchScore(event, payload) {
  const metadata = event && event.metadata ? event.metadata : {};

  if (
    cleanValue(metadata.recast_booking) !== "1" ||
    cleanValue(metadata.appointment_type) !== "seller_callback"
  ) {
    return 0;
  }

  const status = cleanValue(metadata.status).toLowerCase();
  if (status === "cancelled" || status === "completed" || status === "no_show") {
    return 0;
  }

  let score = 0;

  const payloadPhone = normalizePhoneDigits(payload.callbackNumber);
  const inboundPhone = normalizePhoneDigits(payload.inboundCallerId);
  const eventPhone = normalizePhoneDigits(metadata.callback_number);
  const eventInboundPhone = normalizePhoneDigits(metadata.inbound_caller_id);

  if (payloadPhone && eventPhone && payloadPhone.slice(-10) === eventPhone.slice(-10)) {
    score += 60;
  }

  if (payloadPhone && eventInboundPhone && payloadPhone.slice(-10) === eventInboundPhone.slice(-10)) {
    score += 55;
  }

  if (inboundPhone && eventPhone && inboundPhone.slice(-10) === eventPhone.slice(-10)) {
    score += 55;
  }

  if (inboundPhone && eventInboundPhone && inboundPhone.slice(-10) === eventInboundPhone.slice(-10)) {
    score += 55;
  }

  if (duplicateTextMatches(payload.propertyAddress, metadata.property_address)) {
    score += 50;
  }

  if (duplicateTextMatches(payload.callerName, metadata.caller_name)) {
    score += 15;
  }

  return score;
}

async function findMatchingAppointments(payload) {
  const nylasApiKey = getRequiredEnv("NYLAS_API_KEY");
  const nylasGrantId = getRequiredEnv("NYLAS_GRANT_ID");
  const calendarId = process.env.CALENDAR_ID || "primary";

  const now = new Date();
  const startTime = Math.floor(now.getTime() / 1000);
  const endTime = Math.floor(addMinutes(now, 60 * 24 * 90).getTime() / 1000);

  let pageToken = "";
  let checkedEvents = 0;
  const matches = [];

  for (let page = 0; page < 5; page++) {
    const params = new URLSearchParams({
      calendar_id: calendarId,
      start: String(startTime),
      end: String(endTime),
      limit: "50",
      select: "id,title,when,metadata,status,busy"
    });

    if (pageToken) {
      params.set("page_token", pageToken);
    }

    const url =
      `https://api.us.nylas.com/v3/grants/${encodeURIComponent(nylasGrantId)}/events?` +
      params.toString();

    const response = await fetch(url, {
      method: "GET",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${nylasApiKey}`
      }
    });

    const body = await response.json().catch(() => ({}));

    if (!response.ok) {
      return {
        ok: false,
        statusCode: response.status,
        body
      };
    }

    const events = Array.isArray(body.data) ? body.data : [];

    for (const event of events) {
      checkedEvents += 1;

      const eventEnd = getEventEndDate(event);
      if (eventEnd && eventEnd < now) {
        continue;
      }

      const score = appointmentLookupMatchScore(event, payload);

      if (score >= 50) {
        matches.push({
          event,
          score,
          summary: summarizeDuplicateEvent(event)
        });
      }
    }

    pageToken = cleanValue(body.next_cursor);
    if (!pageToken) break;
  }

  matches.sort((a, b) => b.score - a.score);

  return {
    ok: true,
    checkedEvents,
    matches
  };
}

async function handleAppointmentLookup(payload, requestedAction) {
  const lookup = await findMatchingAppointments(payload);

  if (!lookup.ok) {
    console.error("Nylas appointment lookup error", {
      statusCode: lookup.statusCode,
      body: lookup.body
    });

    return jsonResponse(502, {
      status: "error",
      messageForAssistant:
        "I’m having trouble checking the calendar for the existing callback right now. Collect the caller’s request and have the team follow up.",
      error: "nylas_appointment_lookup_failed"
    });
  }

  if (lookup.matches.length === 0) {
    return jsonResponse(200, {
      status: "not_found",
      checkedEvents: lookup.checkedEvents,
      messageForAssistant:
        "I could not find a matching future callback. Ask the caller for the property address, callback number, or the original appointment time so the team can confirm it."
    });
  }

  if (lookup.matches.length === 1) {
    const match = lookup.matches[0];

    return jsonResponse(200, {
      status: "single_match_found",
      appointmentId: match.event.id || "",
      nylasEventId: match.event.id || "",
      matchScore: match.score,
      matchedAppointmentSummary: match.summary,
      messageForAssistant:
        requestedAction === "cancel"
          ? `I see ${match.summary}. Is that the callback you want to cancel?`
          : `I see ${match.summary}. Is that the callback you want to move?`
    });
  }

  return jsonResponse(200, {
    status: "multiple_matches_found",
    checkedEvents: lookup.checkedEvents,
    matches: lookup.matches.slice(0, 5).map((match) => ({
      appointmentId: match.event.id || "",
      nylasEventId: match.event.id || "",
      matchScore: match.score,
      matchedAppointmentSummary: match.summary
    })),
    messageForAssistant:
      "I found more than one possible future callback. Ask the caller which appointment they mean before making any changes."
  });
}


function buildPayloadFromEventMetadata(existingEvent, payload, scheduledStartIso) {
  const metadata = existingEvent && existingEvent.metadata ? existingEvent.metadata : {};

  return {
    ...payload,
    callerName: cleanValue(payload.callerName, metadata.caller_name),
    callbackNumber: cleanValue(payload.callbackNumber, metadata.callback_number),
    inboundCallerId: cleanValue(payload.inboundCallerId, metadata.inbound_caller_id),
    callerEmail: cleanValue(payload.callerEmail, metadata.caller_email),
    propertyAddress: cleanValue(payload.propertyAddress, metadata.property_address),
    ownership: cleanValue(payload.ownership, metadata.ownership),
    reasonSituation: cleanValue(payload.reasonSituation, metadata.reason_situation),
    timelineDeadline: cleanValue(payload.timelineDeadline, metadata.timeline_deadline),
    deadlineDate: cleanValue(payload.deadlineDate, metadata.deadline_date),
    amountOwed: cleanValue(payload.amountOwed, metadata.amount_owed),
    liensIssues: cleanValue(payload.liensIssues, metadata.liens_issues),
    requestedCallbackTime: cleanValue(payload.requestedCallbackTime, metadata.requested_callback_time),
    smsConsent: cleanValue(payload.smsConsent, metadata.sms_consent || "not_asked"),
    exceptionsAdditionalNotes: cleanValue(
      payload.exceptionsAdditionalNotes,
      metadata.exceptions_additional_notes || "Caller requested to reschedule existing appointment."
    ),
    scheduledCallbackTime: scheduledStartIso
  };
}

async function getNylasCalendarEventById(eventId) {
  const nylasApiKey = getRequiredEnv("NYLAS_API_KEY");
  const nylasGrantId = getRequiredEnv("NYLAS_GRANT_ID");
  const calendarId = process.env.CALENDAR_ID || "primary";

  const params = new URLSearchParams({
    calendar_id: calendarId,
    select: "id,title,when,metadata,status,busy,description"
  });

  const url =
    `https://api.us.nylas.com/v3/grants/${encodeURIComponent(nylasGrantId)}/events/${encodeURIComponent(eventId)}?` +
    params.toString();

  const response = await fetch(url, {
    method: "GET",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${nylasApiKey}`
    }
  });

  const body = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      body
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    body,
    event: body && body.data ? body.data : {}
  };
}

async function updateNylasCalendarEventForReschedule(existingEvent, payload, startDate, endDate) {
  const nylasApiKey = getRequiredEnv("NYLAS_API_KEY");
  const nylasGrantId = getRequiredEnv("NYLAS_GRANT_ID");
  const calendarId = process.env.CALENDAR_ID || "primary";
  const eventId = cleanValue(existingEvent.id);

  const scheduledStartIso = formatCentralIso(startDate);
  const scheduledEndIso = formatCentralIso(endDate);
  const previousStartDate = getEventStartDate(existingEvent);
  const previousEndDate = getEventEndDate(existingEvent);
  const previousStartIso = previousStartDate ? formatCentralIso(previousStartDate) : "";
  const previousEndIso = previousEndDate ? formatCentralIso(previousEndDate) : "";

  const mergedPayload = buildPayloadFromEventMetadata(existingEvent, payload, scheduledStartIso);
  const existingMetadata = existingEvent && existingEvent.metadata ? existingEvent.metadata : {};

  const url =
    `https://api.us.nylas.com/v3/grants/${encodeURIComponent(nylasGrantId)}/events/${encodeURIComponent(eventId)}` +
    `?calendar_id=${encodeURIComponent(calendarId)}`;

  const body = {
    title: buildCalendarTitle(mergedPayload),
    description: buildCalendarDescription(mergedPayload, scheduledStartIso, scheduledEndIso),
    busy: true,
    when: {
      start_time: Math.floor(startDate.getTime() / 1000),
      end_time: Math.floor(endDate.getTime() / 1000),
      start_timezone: CENTRAL_TIME_ZONE,
      end_timezone: CENTRAL_TIME_ZONE
    },
    metadata: {
      ...existingMetadata,
      recast_booking: "1",
      appointment_type: "seller_callback",
      source: cleanValue(existingMetadata.source, "voice"),
      intent: "reschedule",
      status: "rescheduled",
      call_id: cleanValue(existingMetadata.call_id || payload.callId),
      original_call_id: cleanValue(existingMetadata.original_call_id || payload.callId),
      latest_call_id: cleanValue(payload.callId, existingMetadata.latest_call_id),
      caller_name: cleanValue(mergedPayload.callerName),
      callback_number: cleanValue(mergedPayload.callbackNumber),
      inbound_caller_id: cleanValue(mergedPayload.inboundCallerId),
      caller_email: cleanValue(mergedPayload.callerEmail),
      property_address: cleanValue(mergedPayload.propertyAddress),
      ownership: cleanValue(mergedPayload.ownership),
      reason_situation: cleanValue(mergedPayload.reasonSituation),
      timeline_deadline: cleanValue(mergedPayload.timelineDeadline),
      deadline_date: cleanValue(mergedPayload.deadlineDate),
      amount_owed: cleanValue(mergedPayload.amountOwed),
      liens_issues: cleanValue(mergedPayload.liensIssues),
      requested_callback_time: cleanValue(mergedPayload.requestedCallbackTime),
      scheduled_callback_time: scheduledStartIso,
      sms_consent: cleanValue(mergedPayload.smsConsent, "not_asked"),
      sms_consent_method: cleanValue(existingMetadata.sms_consent_method, "voice"),
      sms_consent_timestamp: cleanValue(existingMetadata.sms_consent_timestamp, new Date().toISOString()),
      previous_appointment_start: previousStartIso,
      previous_appointment_end: previousEndIso,
      rescheduled_by_call_id: cleanValue(payload.callId),
      matched_appointment_summary: summarizeDuplicateEvent(existingEvent),
      last_updated_by: "recast_api",
      last_updated_at_unix: String(Math.floor(Date.now() / 1000)),
      last_notification_type: cleanValue(existingMetadata.last_notification_type),
      last_notification_at_unix: cleanValue(existingMetadata.last_notification_at_unix)
    }
  };

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${nylasApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      body: responseBody
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    body: responseBody,
    scheduledStartIso,
    scheduledEndIso,
    previousStartIso,
    previousEndIso
  };
}

async function handleConfirmedReschedule(payload) {
  const appointmentId = cleanValue(payload.appointmentId || payload.nylasEventId);
  const selectedStart = parseSelectedStartTime(payload);

  if (!appointmentId) {
    return jsonResponse(200, {
      status: "needs_more_info",
      messageForAssistant:
        "Confirm which existing callback the caller wants to move before rescheduling it."
    });
  }

  if (!selectedStart) {
    return jsonResponse(200, {
      status: "needs_more_info",
      messageForAssistant:
        "Ask the caller which available callback time they want to move the appointment to."
    });
  }

  const existing = await getNylasCalendarEventById(appointmentId);

  if (!existing.ok) {
    console.error("Nylas event fetch error before reschedule", {
      statusCode: existing.statusCode,
      body: existing.body
    });

    return jsonResponse(502, {
      status: "error",
      messageForAssistant:
        "I’m having trouble finding that existing callback on the calendar right now. Collect the caller’s request and have the team follow up.",
      error: "nylas_event_fetch_failed_before_reschedule"
    });
  }

  const metadata = existing.event && existing.event.metadata ? existing.event.metadata : {};

  if (
    cleanValue(metadata.recast_booking) !== "1" ||
    cleanValue(metadata.appointment_type) !== "seller_callback"
  ) {
    return jsonResponse(200, {
      status: "not_found",
      messageForAssistant:
        "I could not confirm that appointment as a Recast seller callback. Ask the caller for the property address, callback number, or original appointment time so the team can follow up."
    });
  }

  const selectedEnd = addMinutes(selectedStart, DEFAULT_SLOT_MINUTES);

  const nylasAvailability = await callNylasFreeBusy(selectedStart, selectedEnd);

  if (!nylasAvailability.ok) {
    console.error("Nylas Free/Busy error before reschedule", {
      statusCode: nylasAvailability.statusCode,
      body: nylasAvailability.body
    });

    return jsonResponse(502, {
      status: "error",
      messageForAssistant:
        "I’m having trouble confirming the calendar right now. Let me collect the preferred callback time and have the team follow up.",
      error: "nylas_free_busy_failed_before_reschedule"
    });
  }

  const busySlots = extractBusySlots(nylasAvailability.body);
  const existingStart = getEventStartDate(existing.event);
  const existingEnd = getEventEndDate(existing.event);

  const hasConflict = busySlots.some((busy) => {
    const overlapsSelectedSlot = rangesOverlap(
      selectedStart.getTime(),
      selectedEnd.getTime(),
      busy.startMs,
      busy.endMs
    );

    if (!overlapsSelectedSlot) return false;

    const overlapsExistingEvent =
      existingStart &&
      existingEnd &&
      rangesOverlap(
        existingStart.getTime(),
        existingEnd.getTime(),
        busy.startMs,
        busy.endMs
      );

    return !overlapsExistingEvent;
  });

  if (hasConflict) {
    return jsonResponse(200, {
      status: "conflict",
      messageForAssistant:
        "That time is not showing as available. Ask the caller for another one-hour callback window."
    });
  }

  const updatedEvent = await updateNylasCalendarEventForReschedule(
    existing.event,
    payload,
    selectedStart,
    selectedEnd
  );

  if (!updatedEvent.ok) {
    console.error("Nylas event update error during reschedule", {
      statusCode: updatedEvent.statusCode,
      body: updatedEvent.body
    });

    return jsonResponse(502, {
      status: "error",
      messageForAssistant:
        "I’m having trouble moving that callback on the calendar. Collect the preferred time and have the team follow up.",
      error: "nylas_event_update_failed_for_reschedule"
    });
  }

  const eventData = updatedEvent.body && updatedEvent.body.data ? updatedEvent.body.data : {};

  return jsonResponse(200, {
    status: "rescheduled",
    appointmentId: eventData.id || appointmentId,
    nylasEventId: eventData.id || appointmentId,
    previousStartTime: updatedEvent.previousStartIso,
    previousEndTime: updatedEvent.previousEndIso,
    scheduledStartTime: updatedEvent.scheduledStartIso,
    scheduledEndTime: updatedEvent.scheduledEndIso,
    calendarId: eventData.calendar_id || process.env.CALENDAR_ID || "primary",
    messageForAssistant:
      `Your callback has been moved to ${spokenCentralTime(selectedStart)} Central.`
  });
}


async function updateNylasCalendarEventForCancel(existingEvent, payload) {
  const nylasApiKey = getRequiredEnv("NYLAS_API_KEY");
  const nylasGrantId = getRequiredEnv("NYLAS_GRANT_ID");
  const calendarId = process.env.CALENDAR_ID || "primary";
  const eventId = cleanValue(existingEvent.id);
  const existingMetadata = existingEvent && existingEvent.metadata ? existingEvent.metadata : {};
  const existingTitle = cleanValue(existingEvent.title, "Seller Call");
  const cancelledTitle = existingTitle.toLowerCase().startsWith("cancelled -")
    ? existingTitle
    : `CANCELLED - ${existingTitle}`;

  const startDate = getEventStartDate(existingEvent);
  const endDate = getEventEndDate(existingEvent);
  const scheduledStartIso = startDate ? formatCentralIso(startDate) : cleanValue(existingMetadata.scheduled_callback_time);
  const scheduledEndIso = endDate ? formatCentralIso(endDate) : "";

  const url =
    `https://api.us.nylas.com/v3/grants/${encodeURIComponent(nylasGrantId)}/events/${encodeURIComponent(eventId)}` +
    `?calendar_id=${encodeURIComponent(calendarId)}`;

  const body = {
    title: cancelledTitle,
    busy: false,
    metadata: {
      ...existingMetadata,
      recast_booking: "1",
      appointment_type: "seller_callback",
      intent: "cancel",
      status: "cancelled",
      latest_call_id: cleanValue(payload.callId, existingMetadata.latest_call_id),
      cancellation_by_call_id: cleanValue(payload.callId),
      cancellation_requested_at_unix: String(Math.floor(Date.now() / 1000)),
      cancelled_appointment_start: scheduledStartIso,
      cancelled_appointment_end: scheduledEndIso,
      matched_appointment_summary: summarizeDuplicateEvent(existingEvent),
      last_updated_by: "recast_api",
      last_updated_at_unix: String(Math.floor(Date.now() / 1000)),
      last_notification_type: cleanValue(existingMetadata.last_notification_type),
      last_notification_at_unix: cleanValue(existingMetadata.last_notification_at_unix)
    }
  };

  const response = await fetch(url, {
    method: "PUT",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${nylasApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      body: responseBody
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    body: responseBody,
    cancelledStartIso: scheduledStartIso,
    cancelledEndIso: scheduledEndIso
  };
}

async function handleConfirmedCancel(payload) {
  const appointmentId = cleanValue(payload.appointmentId || payload.nylasEventId);

  if (!appointmentId) {
    return jsonResponse(200, {
      status: "needs_more_info",
      messageForAssistant:
        "Confirm which existing callback the caller wants to cancel before cancelling it."
    });
  }

  const existing = await getNylasCalendarEventById(appointmentId);

  if (!existing.ok) {
    console.error("Nylas event fetch error before cancel", {
      statusCode: existing.statusCode,
      body: existing.body
    });

    return jsonResponse(502, {
      status: "error",
      messageForAssistant:
        "I’m having trouble finding that existing callback on the calendar right now. Collect the caller’s request and have the team follow up.",
      error: "nylas_event_fetch_failed_before_cancel"
    });
  }

  const metadata = existing.event && existing.event.metadata ? existing.event.metadata : {};

  if (
    cleanValue(metadata.recast_booking) !== "1" ||
    cleanValue(metadata.appointment_type) !== "seller_callback"
  ) {
    return jsonResponse(200, {
      status: "not_found",
      messageForAssistant:
        "I could not confirm that appointment as a Recast seller callback. Ask the caller for the property address, callback number, or original appointment time so the team can follow up."
    });
  }

  const status = cleanValue(metadata.status).toLowerCase();

  if (status === "cancelled") {
    return jsonResponse(200, {
      status: "cancelled",
      appointmentId,
      nylasEventId: appointmentId,
      cancelledStartTime: cleanValue(metadata.cancelled_appointment_start || metadata.scheduled_callback_time),
      messageForAssistant:
        "That callback is already marked as cancelled."
    });
  }

  const cancelledEvent = await updateNylasCalendarEventForCancel(existing.event, payload);

  if (!cancelledEvent.ok) {
    console.error("Nylas event update error during cancel", {
      statusCode: cancelledEvent.statusCode,
      body: cancelledEvent.body
    });

    return jsonResponse(502, {
      status: "error",
      messageForAssistant:
        "I’m having trouble cancelling that callback on the calendar. Collect the caller’s request and have the team follow up.",
      error: "nylas_event_update_failed_for_cancel"
    });
  }

  const eventData = cancelledEvent.body && cancelledEvent.body.data ? cancelledEvent.body.data : {};

  return jsonResponse(200, {
    status: "cancelled",
    appointmentId: eventData.id || appointmentId,
    nylasEventId: eventData.id || appointmentId,
    cancelledStartTime: cancelledEvent.cancelledStartIso,
    cancelledEndTime: cancelledEvent.cancelledEndIso,
    calendarId: eventData.calendar_id || process.env.CALENDAR_ID || "primary",
    messageForAssistant:
      "Your callback has been cancelled."
  });
}

async function handleCancelAction(payload) {
  const appointmentId = cleanValue(payload.appointmentId || payload.nylasEventId);

  if (appointmentId) {
    return await handleConfirmedCancel(payload);
  }

  return await handleAppointmentLookup(payload, "cancel");
}

async function handleRescheduleAction(payload) {
  const appointmentId = cleanValue(payload.appointmentId || payload.nylasEventId);
  const selectedStart = parseSelectedStartTime(payload);

  if (appointmentId && selectedStart) {
    return await handleConfirmedReschedule(payload);
  }

  if (appointmentId && !selectedStart) {
    return jsonResponse(200, {
      status: "needs_more_info",
      appointmentId,
      nylasEventId: appointmentId,
      messageForAssistant:
        "Ask the caller for the new callback day and time. I need a clear future callback time before I can move the appointment."
    });
  }

  return await handleAppointmentLookup(payload, "reschedule");
}

function buildCalendarDescription(payload, scheduledStartIso, scheduledEndIso) {
  return [
    "RECAST SELLER CALLBACK",
    "",
    "CALLER",
    `Name: ${cleanValue(payload.callerName)}`,
    `Callback Number: ${cleanValue(payload.callbackNumber)}`,
    "",
    "PROPERTY",
    `Address / Location: ${cleanValue(payload.propertyAddress)}`,
    `Ownership: ${cleanValue(payload.ownership)}`,
    "",
    "SITUATION",
    `Reason / Situation: ${cleanValue(payload.reasonSituation)}`,
    `Timeline / Deadline: ${cleanValue(payload.timelineDeadline)}`,
    `Amount Owed: ${cleanValue(payload.amountOwed)}`,
    `Liens / Issues: ${cleanValue(payload.liensIssues)}`,
    "",
    "CALLBACK",
    `Requested Callback Time: ${cleanValue(payload.requestedCallbackTime)}`,
    `Scheduled Callback Time: ${scheduledStartIso}`,
    "",
    "OTHER",
    `SMS Consent: ${cleanValue(payload.smsConsent, "not_asked")}`,
    `Exceptions / Additional Notes: ${cleanValue(payload.exceptionsAdditionalNotes)}`,
    `Call ID: ${cleanValue(payload.callId)}`,
    "Transcript: See Calls sheet",
    "Recording:"
  ].join("\n");
}

function addMinutes(date, minutes) {
  return new Date(date.getTime() + minutes * 60 * 1000);
}

function parseSelectedStartTime(payload) {
  const now = new Date();
  const rawStartTime = cleanValue(payload.requestedStartTime);

  if (rawStartTime) {
    const parsedStartTime = new Date(rawStartTime);

    if (!Number.isNaN(parsedStartTime.getTime()) && parsedStartTime > now) {
      return parsedStartTime;
    }

    console.warn("Ignoring invalid or past requestedStartTime", {
      requestedStartTime: rawStartTime
    });
  }

  const naturalCallbackTime = cleanValue(payload.requestedCallbackTime);

  if (!naturalCallbackTime) {
    return null;
  }

  const parsedWindow = parseRequestedWindow(naturalCallbackTime, now);

  if (
    parsedWindow &&
    parsedWindow.start &&
    parsedWindow.end &&
    parsedWindow.end > parsedWindow.start &&
    parsedWindow.start > now
  ) {
    return parsedWindow.start;
  }

  console.warn("Could not parse future requestedCallbackTime", {
    requestedCallbackTime: naturalCallbackTime
  });

  return null;
}

async function createNylasCalendarEvent(payload, startDate, endDate) {
  const nylasApiKey = getRequiredEnv("NYLAS_API_KEY");
  const nylasGrantId = getRequiredEnv("NYLAS_GRANT_ID");
  const calendarId = process.env.CALENDAR_ID || "primary";

  const scheduledStartIso = formatCentralIso(startDate);
  const scheduledEndIso = formatCentralIso(endDate);

  const url =
    `https://api.us.nylas.com/v3/grants/${encodeURIComponent(nylasGrantId)}/events` +
    `?calendar_id=${encodeURIComponent(calendarId)}`;

  const body = {
    title: buildCalendarTitle(payload),
    description: buildCalendarDescription(payload, scheduledStartIso, scheduledEndIso),
    busy: true,
    when: {
      start_time: Math.floor(startDate.getTime() / 1000),
      end_time: Math.floor(endDate.getTime() / 1000),
      start_timezone: CENTRAL_TIME_ZONE,
      end_timezone: CENTRAL_TIME_ZONE
    },
    metadata: {
      recast_booking: "1",
      appointment_type: "seller_callback",
      source: "voice",
      intent: "new_appointment",
      status: "booked",
      call_id: cleanValue(payload.callId),
      original_call_id: cleanValue(payload.callId),
      latest_call_id: cleanValue(payload.callId),
      caller_name: cleanValue(payload.callerName),
      callback_number: cleanValue(payload.callbackNumber),
      inbound_caller_id: cleanValue(payload.inboundCallerId),
      caller_email: cleanValue(payload.callerEmail),
      property_address: cleanValue(payload.propertyAddress),
      ownership: cleanValue(payload.ownership),
      reason_situation: cleanValue(payload.reasonSituation),
      timeline_deadline: cleanValue(payload.timelineDeadline),
      deadline_date: cleanValue(payload.deadlineDate),
      amount_owed: cleanValue(payload.amountOwed),
      liens_issues: cleanValue(payload.liensIssues),
      requested_callback_time: cleanValue(payload.requestedCallbackTime),
      scheduled_callback_time: scheduledStartIso,
      sms_consent: cleanValue(payload.smsConsent, "not_asked"),
      sms_consent_method: "voice",
      sms_consent_timestamp: new Date().toISOString(),
      last_updated_by: "recast_api",
      last_updated_at_unix: String(Math.floor(Date.now() / 1000)),
      last_notification_type: "",
      last_notification_at_unix: ""
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${nylasApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(body)
  });

  const responseBody = await response.json().catch(() => ({}));

  if (!response.ok) {
    return {
      ok: false,
      statusCode: response.status,
      body: responseBody
    };
  }

  return {
    ok: true,
    statusCode: response.status,
    body: responseBody,
    scheduledStartIso,
    scheduledEndIso
  };
}

async function handleBook(payload) {
  const selectedStart = parseSelectedStartTime(payload);

  if (!selectedStart) {
    return jsonResponse(200, {
      status: "needs_more_info",
      messageForAssistant:
        "Ask the caller which available callback time they want to schedule."
    });
  }

  const selectedEnd = addMinutes(selectedStart, DEFAULT_SLOT_MINUTES);

  const nylasAvailability = await callNylasFreeBusy(selectedStart, selectedEnd);

  if (!nylasAvailability.ok) {
    console.error("Nylas Free/Busy error before booking", {
      statusCode: nylasAvailability.statusCode,
      body: nylasAvailability.body
    });

    return jsonResponse(502, {
      status: "error",
      messageForAssistant:
        "I’m having trouble confirming the calendar right now. Let me collect the preferred callback time and have the team follow up.",
      error: "nylas_free_busy_failed_before_booking"
    });
  }

  const busySlots = extractBusySlots(nylasAvailability.body);
  const hasConflict = busySlots.some((busy) =>
    rangesOverlap(
      selectedStart.getTime(),
      selectedEnd.getTime(),
      busy.startMs,
      busy.endMs
    )
  );

  if (hasConflict) {
    return jsonResponse(200, {
      status: "conflict",
      messageForAssistant:
        "That time is no longer showing as available. Ask the caller for another one-hour callback window."
    });
  }

  const duplicateCheck = await findFutureDuplicateAppointment(payload, selectedStart);

  if (!duplicateCheck.ok) {
    console.error("Nylas duplicate lookup error before booking", {
      statusCode: duplicateCheck.statusCode,
      body: duplicateCheck.body
    });

    return jsonResponse(502, {
      status: "error",
      messageForAssistant:
        "I’m having trouble checking for an existing callback right now. Let me collect the preferred callback time and have the team follow up.",
      error: "nylas_duplicate_lookup_failed"
    });
  }

  if (duplicateCheck.duplicateFound) {
    return jsonResponse(200, {
      status: "possible_duplicate",
      appointmentId: duplicateCheck.event.id || "",
      nylasEventId: duplicateCheck.event.id || "",
      matchedAppointmentSummary: summarizeDuplicateEvent(duplicateCheck.event),
      messageForAssistant:
        "It looks like there may already be a future callback scheduled. Confirm with the caller before creating another callback."
    });
  }

  const createdEvent = await createNylasCalendarEvent(
    payload,
    selectedStart,
    selectedEnd
  );

  if (!createdEvent.ok) {
    console.error("Nylas event creation error", {
      statusCode: createdEvent.statusCode,
      body: createdEvent.body
    });

    return jsonResponse(502, {
      status: "error",
      messageForAssistant:
        "I’m having trouble putting that callback on the calendar. Let me collect the preferred time and have the team follow up.",
      error: "nylas_event_creation_failed"
    });
  }

  const eventData = createdEvent.body && createdEvent.body.data ? createdEvent.body.data : {};

  return jsonResponse(200, {
    status: "booked",
    appointmentId: eventData.id || "",
    nylasEventId: eventData.id || "",
    scheduledStartTime: createdEvent.scheduledStartIso,
    scheduledEndTime: createdEvent.scheduledEndIso,
    calendarId: eventData.calendar_id || process.env.CALENDAR_ID || "primary",
    messageForAssistant:
      `Your callback is scheduled for ${spokenCentralTime(selectedStart)} Central.`
  });
}


async function handleNylasTest() {
  const now = new Date();
  const start = new Date(now.getTime() + 15 * 60 * 1000);
  const end = new Date(now.getTime() + 75 * 60 * 1000);

  const nylasResult = await callNylasFreeBusy(start, end);

  if (!nylasResult.ok) {
    return jsonResponse(502, {
      status: "nylas_error",
      message: "Nylas connectivity test failed.",
      checkedWindow: {
        startTimeUnix: Math.floor(start.getTime() / 1000),
        endTimeUnix: Math.floor(end.getTime() / 1000)
      },
      nylasBody: nylasResult.body
    });
  }

  return jsonResponse(200, {
    status: "nylas_connected",
    message: "Nylas connectivity test succeeded.",
    calendarEmail: process.env.CALENDAR_EMAIL,
    calendarId: process.env.CALENDAR_ID || "primary",
    checkedWindow: {
      startTimeUnix: Math.floor(start.getTime() / 1000),
      endTimeUnix: Math.floor(end.getTime() / 1000)
    },
    nylasBody: nylasResult.body
  });
}

exports.handler = async function handler(event) {
  try {
    const authError = verifyRequest(event);
    if (authError) return authError;

    const payload = parseBody(event);
    const receivedAt = new Date().toISOString();

    console.log("appointment_action payload", {
      receivedAt,
      payload
    });

    const action = payload.action;

    if (action === "availability") {
      return await handleAvailability(payload);
    }

    if (action === "book") {
      return await handleBook(payload);
    }

    if (action === "reschedule") {
      return await handleRescheduleAction(payload);
    }

    if (action === "cancel") {
      return await handleCancelAction(payload);
    }

    if (action === "nylas_test") {
      return await handleNylasTest();
    }

    return jsonResponse(400, {
      status: "error",
      messageForAssistant:
        "The appointment action was missing or invalid. Ask the caller for the callback request again.",
      receivedAction: action || null
    });
  } catch (error) {
    console.error("appointment_action error", {
      message: error.message,
      stack: error.stack
    });

    return jsonResponse(500, {
      status: "error",
      messageForAssistant:
        "Something went wrong checking the appointment system. Let me collect the preferred callback time and have the team follow up.",
      error: error.message
    });
  }
};

// Test-only exports. Netlify uses only exports.handler above.
// These do not change runtime behavior.
exports._internals = {
  parseRequestedWindow,
  parseSelectedStartTime,
  findRequestedDate,
  normalizeSpokenTimeWords,
  inferBusinessHour
};
