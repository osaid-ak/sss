const SPREADSHEET_ID = "1k-2i2LNA_tnsEQVghJvVH7F16-8C8HxvUFwIe3RZ7IM";
const TAB_GID = 1806071421;

function doGet() {
  const ss = SpreadsheetApp.openById(SPREADSHEET_ID);
  const sheet = ss.getSheets().filter(function (tab) { return tab.getSheetId() === TAB_GID; })[0];
  if (!sheet) {
    return ContentService.createTextOutput(JSON.stringify({ error: "Weekend Cover tab was not found." }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const payload = {
    spreadsheetTitle: ss.getName(),
    tab: sheet.getName(),
    gid: TAB_GID,
    fetchedAt: new Date().toISOString(),
    source: "actual",
    weekends: parseWeekendRows(sheet.getDataRange().getDisplayValues())
  };
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function cell(row, index) {
  if (index < 0 || index >= row.length) return "";
  return String(row[index] || "").replace(/\n/g, " ").trim();
}

function headerLabel(raw) {
  return String(raw || "").replace(/\s+/g, " ").trim().toUpperCase();
}

function parseDate(raw) {
  const text = String(raw || "").replace(/\s+/g, " ").trim();
  const match = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (!match) return null;
  const months = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };
  const month = months[match[2].slice(0, 3).toLowerCase()];
  if (!month) return null;
  return match[3] + "-" + ("0" + month).slice(-2) + "-" + ("0" + Number(match[1])).slice(-2);
}

function vipNames(first, second) {
  const names = [];
  [first, second].forEach(function (name) {
    if (name && names.indexOf(name) === -1) names.push(name);
  });
  return names;
}

function parseWeekendRows(rows) {
  let headerIndex = -1;
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < rows[i].length; j++) {
      if (headerLabel(rows[i][j]) === "ACTUAL COVER") headerIndex = i;
    }
  }
  if (headerIndex < 0) throw new Error("Could not find the Actual Cover header.");
  const header = rows[headerIndex];
  function labelAt(name) {
    for (let j = 0; j < header.length; j++) if (headerLabel(header[j]) === name) return j;
    return -1;
  }
  const plannedAt = Math.max(labelAt("PLANNED COVER"), 1);
  const actualAt = labelAt("ACTUAL COVER");
  let swapAt = -1;
  let remarksAt = -1;
  for (let j = 0; j < header.length; j++) {
    const label = headerLabel(header[j]);
    if (swapAt < 0 && label.indexOf("SWAP") === 0) swapAt = j;
    if (remarksAt < 0 && label.indexOf("REMARK") >= 0) remarksAt = j;
  }
  if (swapAt < 0) swapAt = plannedAt + 3;
  const statusAt = Math.max(labelAt("STATUS"), actualAt + 3);
  if (remarksAt < 0) remarksAt = statusAt + 1;
  const weekends = [];
  for (let i = headerIndex + 1; i < rows.length; i++) {
    const row = rows[i];
    const dateKey = parseDate(cell(row, 0));
    if (!dateKey) continue;
    const plannedP1 = cell(row, plannedAt);
    const plannedVip = [cell(row, plannedAt + 1), cell(row, plannedAt + 2)];
    const swapP1 = cell(row, swapAt);
    const swapVip = [cell(row, swapAt + 1), cell(row, swapAt + 2)];
    const swapped = !!(swapP1 || swapVip[0] || swapVip[1]);
    let phase1 = swapP1 || plannedP1;
    let vip = vipNames(swapVip[0] || plannedVip[0], swapVip[1] || plannedVip[1]);
    if (!phase1 && !vip.length) {
      phase1 = cell(row, actualAt);
      vip = vipNames(cell(row, actualAt + 1), cell(row, actualAt + 2));
    }
    if (!phase1 && !vip.length) continue;
    let status = cell(row, statusAt);
    if (!swapped) status = "✓ Planned";
    else if (!status || status.toLowerCase().indexOf("planned") >= 0) status = "↻ Swapped";
    weekends.push({
      date: dateKey,
      phase1: phase1,
      vip: vip,
      status: status,
      remarks: cell(row, remarksAt),
      swapped: swapped
    });
  }
  return weekends;
}
