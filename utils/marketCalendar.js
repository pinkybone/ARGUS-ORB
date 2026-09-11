// utils/marketCalendar.js
// NYSE/NASDAQ full-day US equity market closures. Early-close sessions (e.g.
// 1:00 PM ET) are still trading days — only full closures are excluded.

var cache = {};

function ymdInET(date) {
  return (date || new Date()).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
}

function weekdayShortET(date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York", weekday: "short"
  }).format(date || new Date());
}

function padYMD(y, m, d) {
  return y + "-" + String(m).padStart(2, "0") + "-" + String(d).padStart(2, "0");
}

function dateFromYMD(ymd) {
  var p = ymd.split("-");
  return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10), 12, 0, 0);
}

function weekdayFromYMD(ymd) {
  return weekdayShortET(dateFromYMD(ymd));
}

function addDaysYMD(ymd, days) {
  var d = dateFromYMD(ymd);
  d.setDate(d.getDate() + days);
  return padYMD(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

function easterSunday(year) {
  var a = year % 19;
  var b = Math.floor(year / 100);
  var c = year % 100;
  var d = Math.floor(b / 4);
  var e = b % 4;
  var f = Math.floor((b + 8) / 25);
  var g = Math.floor((b - f + 1) / 3);
  var h = (19 * a + b - d - g + 15) % 30;
  var i = Math.floor(c / 4);
  var k = c % 4;
  var l = (32 + 2 * e + 2 * i - h - k) % 7;
  var m = Math.floor((a + 11 * h + 22 * l) / 451);
  var month = Math.floor((h + l - 7 * m + 114) / 31);
  var day = ((h + l - 7 * m + 114) % 31) + 1;
  return padYMD(year, month, day);
}

function nthWeekdayYMD(year, month, targetWd, n) {
  var count = 0;
  for (var day = 1; day <= 31; day++) {
    var ymd = padYMD(year, month, day);
    if (parseInt(ymd.split("-")[1], 10) !== month) break;
    if (weekdayFromYMD(ymd) === targetWd) {
      count++;
      if (count === n) return ymd;
    }
  }
  return null;
}

function lastWeekdayYMD(year, month, targetWd) {
  var last = null;
  for (var day = 1; day <= 31; day++) {
    var ymd = padYMD(year, month, day);
    if (parseInt(ymd.split("-")[1], 10) !== month) break;
    if (weekdayFromYMD(ymd) === targetWd) last = ymd;
  }
  return last;
}

function addObservedFixed(closed, names, year, month, day, label) {
  var ymd = padYMD(year, month, day);
  var wd = weekdayFromYMD(ymd);
  if (wd === "Sat") ymd = addDaysYMD(ymd, -1);
  else if (wd === "Sun") ymd = addDaysYMD(ymd, 1);
  closed[ymd] = true;
  names[ymd] = (ymd === padYMD(year, month, day)) ? label : label + " (observed)";
}

function buildYearHolidays(year) {
  var closed = {};
  var names = {};

  addObservedFixed(closed, names, year, 1, 1, "New Year's Day");
  addObservedFixed(closed, names, year, 6, 19, "Juneteenth");
  addObservedFixed(closed, names, year, 7, 4, "Independence Day");
  addObservedFixed(closed, names, year, 12, 25, "Christmas");

  // Jan 1 on Saturday closes prior Dec 31 (e.g. observed New Year's Eve).
  var jan1Next = padYMD(year + 1, 1, 1);
  if (weekdayFromYMD(jan1Next) === "Sat") {
    var eve = addDaysYMD(jan1Next, -1);
    closed[eve] = true;
    names[eve] = "New Year's Day (observed)";
  }

  var mlk = nthWeekdayYMD(year, 1, "Mon", 3);
  if (mlk) { closed[mlk] = true; names[mlk] = "Martin Luther King Jr. Day"; }

  var presidents = nthWeekdayYMD(year, 2, "Mon", 3);
  if (presidents) { closed[presidents] = true; names[presidents] = "Presidents' Day"; }

  var goodFriday = addDaysYMD(easterSunday(year), -2);
  closed[goodFriday] = true;
  names[goodFriday] = "Good Friday";

  var memorial = lastWeekdayYMD(year, 5, "Mon");
  if (memorial) { closed[memorial] = true; names[memorial] = "Memorial Day"; }

  var labor = nthWeekdayYMD(year, 9, "Mon", 1);
  if (labor) { closed[labor] = true; names[labor] = "Labor Day"; }

  var thanksgiving = nthWeekdayYMD(year, 11, "Thu", 4);
  if (thanksgiving) { closed[thanksgiving] = true; names[thanksgiving] = "Thanksgiving"; }

  return { closed: closed, names: names };
}

function getYearHolidays(year) {
  if (!cache[year]) cache[year] = buildYearHolidays(year);
  return cache[year];
}

function isMarketClosedET(date) {
  var ymd = ymdInET(date);
  var year = parseInt(ymd.slice(0, 4), 10);
  return !!getYearHolidays(year).closed[ymd];
}

function isWeekendET(date) {
  var wd = weekdayShortET(date);
  return wd === "Sat" || wd === "Sun";
}

function isTradingDayET(date) {
  if (isWeekendET(date)) return false;
  return !isMarketClosedET(date);
}

function nextTradingDay(from) {
  var cursor = new Date((from || new Date()).getTime());
  for (var i = 0; i < 366; i++) {
    if (isTradingDayET(cursor)) return cursor;
    cursor = new Date(cursor.getTime() + 86400000);
  }
  return cursor;
}

// First trading day strictly after the ET calendar date of `from`.
function nextTradingDayAfter(from) {
  var cursor = new Date((from || new Date()).getTime() + 86400000);
  return nextTradingDay(cursor);
}

function addTradingDays(from, days) {
  var cursor = nextTradingDay(from || new Date());
  var added = 0;
  while (added < days) {
    cursor = new Date(cursor.getTime() + 86400000);
    if (isTradingDayET(cursor)) added++;
  }
  return cursor;
}

function holidayNameET(date) {
  var ymd = ymdInET(date);
  var year = parseInt(ymd.slice(0, 4), 10);
  return getYearHolidays(year).names[ymd]
    || getYearHolidays(year + 1).names[ymd]
    || null;
}

module.exports = {
  ymdInET: ymdInET,
  isWeekendET: isWeekendET,
  isMarketClosedET: isMarketClosedET,
  isTradingDayET: isTradingDayET,
  nextTradingDay: nextTradingDay,
  nextTradingDayAfter: nextTradingDayAfter,
  addTradingDays: addTradingDays,
  holidayNameET: holidayNameET,
  getYearHolidays: getYearHolidays
};
