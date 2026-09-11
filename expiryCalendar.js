// utils/expiryCalendar.js — calendar-based option expiry selection (ET).

var marketCal = require("./marketCalendar");

var QUARTER_MONTHS = [3, 6, 9, 12];
var WD_OFFSET = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 0 };

function weekdayET(ymd) {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short" })
    .format(new Date(ymd + "T12:00:00"));
}

function addDaysYmd(ymd, days) {
  var d = new Date(ymd + "T12:00:00");
  d.setDate(d.getDate() + days);
  return marketCal.ymdInET(d);
}

function ymdParts(ymd) {
  var p = ymd.split("-");
  return { y: parseInt(p[0], 10), m: parseInt(p[1], 10), d: parseInt(p[2], 10) };
}

function thirdFriday(year, month) {
  var count = 0;
  for (var day = 1; day <= 31; day++) {
    var ymd = year + "-" + String(month).padStart(2, "0") + "-" + String(day).padStart(2, "0");
    if (parseInt(ymd.split("-")[1], 10) !== month) break;
    if (weekdayET(ymd) !== "Fri") continue;
    count++;
    if (count === 3) return ymd;
  }
  return null;
}

function daysBetween(a, b) {
  return Math.round((new Date(b + "T12:00:00").getTime() - new Date(a + "T12:00:00").getTime()) / 86400000);
}

function matchClosestExpiry(expiries, targetYmd, maxDays) {
  if (!targetYmd) return null;
  if (expiries.indexOf(targetYmd) !== -1) return targetYmd;
  var best = null;
  var bestDiff = Infinity;
  var limit = maxDays || 4;
  for (var i = 0; i < expiries.length; i++) {
    var exp = expiries[i];
    var diff = Math.abs(daysBetween(targetYmd, exp));
    if (diff > limit) continue;
    if (diff < bestDiff) { bestDiff = diff; best = exp; }
  }
  if (best) return best;
  return matchExpiry(expiries, targetYmd);
}

function matchExpiry(expiries, targetYmd) {
  if (!expiries || !expiries.length || !targetYmd) return null;
  if (expiries.indexOf(targetYmd) !== -1) return targetYmd;
  for (var i = 0; i < expiries.length; i++) {
    if (expiries[i] >= targetYmd) return expiries[i];
  }
  return null;
}

function nextTradingFridayAfter(ymd) {
  var cursor = addDaysYmd(ymd, 1);
  for (var i = 0; i < 14; i++) {
    if (weekdayET(cursor) === "Fri" && marketCal.isTradingDayET(new Date(cursor + "T12:00:00"))) {
      return cursor;
    }
    cursor = addDaysYmd(cursor, 1);
  }
  return null;
}

function fridayOfTradingWeek(todayYmd) {
  var wd = weekdayET(todayYmd);
  if (wd === "Fri") {
    if (marketCal.isTradingDayET(new Date(todayYmd + "T12:00:00"))) return todayYmd;
    return nextTradingFridayAfter(todayYmd);
  }
  if (wd === "Sat" || wd === "Sun") return nextTradingFridayAfter(todayYmd);
  var toFri = { Mon: 4, Tue: 3, Wed: 2, Thu: 1 }[wd];
  var fri = addDaysYmd(todayYmd, toFri);
  if (marketCal.isTradingDayET(new Date(fri + "T12:00:00"))) return fri;
  return nextTradingFridayAfter(todayYmd);
}

function monthlyExpiry(todayYmd) {
  var parts = ymdParts(todayYmd);
  var tf = thirdFriday(parts.y, parts.m);
  if (tf && tf > todayYmd) return tf;
  var m = parts.m + 1;
  var y = parts.y;
  if (m > 12) { m = 1; y++; }
  return thirdFriday(y, m);
}

function quarterlyExpiry(todayYmd) {
  var parts = ymdParts(todayYmd);
  for (var y = parts.y; y <= parts.y + 1; y++) {
    for (var i = 0; i < QUARTER_MONTHS.length; i++) {
      var qm = QUARTER_MONTHS[i];
      if (y === parts.y && qm < parts.m) continue;
      var tf = thirdFriday(y, qm);
      if (tf && tf > todayYmd) return tf;
    }
  }
  return null;
}

function pickWeeklyExpiry(expiries, todayYmd) {
  var target = fridayOfTradingWeek(todayYmd);
  if (!expiries || !expiries.length) return target;
  if (expiries.indexOf(target) !== -1) return target;
  return matchClosestExpiry(expiries, target, 3);
}

function pickMonthlyExpiry(expiries, todayYmd) {
  return matchClosestExpiry(expiries, monthlyExpiry(todayYmd), 4);
}

function pickQuarterlyExpiry(expiries, todayYmd) {
  return matchClosestExpiry(expiries, quarterlyExpiry(todayYmd), 4);
}

module.exports = {
  pickWeeklyExpiry: pickWeeklyExpiry,
  pickMonthlyExpiry: pickMonthlyExpiry,
  pickQuarterlyExpiry: pickQuarterlyExpiry,
  fridayOfTradingWeek: fridayOfTradingWeek,
  monthlyExpiry: monthlyExpiry,
  quarterlyExpiry: quarterlyExpiry,
  thirdFriday: thirdFriday
};
