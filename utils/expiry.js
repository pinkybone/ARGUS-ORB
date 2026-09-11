// utils/expiry.js
// Configurable days-to-expiry per ticker. Source of truth: persisted settings (dashboard).

var settings = require("./settings");
var marketCal = require("./marketCalendar");

var MONTHS = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

function getDTE(ticker) {
  return settings.getDTE(ticker);
}

function getExpiryDate(ticker) {
  return marketCal.addTradingDays(new Date(), getDTE(ticker));
}

function getExpiryDateForDTE(dte) {
  return marketCal.addTradingDays(new Date(), dte);
}

function getExpiry(ticker) {
  return marketCal.ymdInET(getExpiryDate(ticker));
}

function getExpiryForDTE(dte) {
  return marketCal.ymdInET(getExpiryDateForDTE(dte));
}

function getDTELabel(ticker) {
  return getDTE(ticker) + "DTE";
}

function formatExpiryLabel(ymd) {
  if (!ymd || ymd.indexOf("-") === -1) return ymd || "";
  var parts = ymd.split("-");
  var month = parseInt(parts[1], 10);
  var day = parseInt(parts[2], 10);
  var ord = (day % 10 === 1 && day !== 11) ? "st"
    : (day % 10 === 2 && day !== 12) ? "nd"
    : (day % 10 === 3 && day !== 13) ? "rd" : "th";
  return MONTHS[month - 1] + " " + day + ord;
}

function getExpiryInfo(ticker) {
  var dte = getDTE(ticker);
  var expiry = getExpiry(ticker);
  var date = getExpiryDate(ticker);
  var weekday = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "long" }).format(date);
  return {
    ticker: ticker,
    dte: dte,
    expiry: expiry,
    label: dte + "DTE",
    formatted: formatExpiryLabel(expiry),
    weekday: weekday
  };
}

function contractLabel(ticker, side, strike, ymd) {
  var s = (strike === null || strike === undefined) ? "?" : strike;
  var sideLabel = side === "call" ? "Call" : "Put";
  return "$" + ticker + " " + s + " " + sideLabel + " - " + formatExpiryLabel(ymd);
}

module.exports = {
  getDTE: getDTE,
  getExpiryDate: getExpiryDate,
  getExpiry: getExpiry,
  getExpiryForDTE: getExpiryForDTE,
  getExpiryDateForDTE: getExpiryDateForDTE,
  getDTELabel: getDTELabel,
  getExpiryInfo: getExpiryInfo,
  formatExpiryLabel: formatExpiryLabel,
  contractLabel: contractLabel
};
