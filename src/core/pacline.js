export const USER_OPEN = "var __user = (function () {";

const LINE_BREAK = /\r\n?|\n|\u2028|\u2029/;

export function userPacLine(systemPac, userPac, line) {
  const open = systemPac.split(LINE_BREAK).indexOf(USER_OPEN);
  if (open < 0) throw new Error("System PAC has no User PAC block");
  const userLine = line - open - 1;
  return userLine >= 1 && userLine <= userPac.split(LINE_BREAK).length ? userLine : null;
}
