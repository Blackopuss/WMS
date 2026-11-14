// Public API of platform/terminals: shared terminals with PIN (WMS-38, ADR 0061).
export {
  TERMINALS_MAX,
  TERMINAL_NAME_MAX,
  TERMINAL_REMOVE_REASON_MAX,
  getTerminal,
  listTerminals,
  registerTerminal,
  removeTerminal,
  terminalFacilities,
} from "./terminals";
export type {
  RegisterTerminalResult,
  RemoveTerminalResult,
  TerminalActor,
  TerminalView,
} from "./terminals";
export { getMyPinStatus, removeMyPin, setMyPin } from "./pins";
export type { MyPinStatus, PinResult } from "./pins";
export {
  ACCOUNT_SETUP_MESSAGE,
  WRONG_PIN_MESSAGE,
  getTerminalScreen,
  pinSignIn,
} from "./sign-in";
export type {
  PinSignInResult,
  TerminalPerson,
  TerminalScreen,
} from "./sign-in";
export {
  PIN_MAX_LENGTH,
  PIN_MIN_LENGTH,
  isPinShape,
  isTrivialPin,
  pinProblem,
} from "./pin-rules";
export {
  IDLE_MINUTES,
  PIN_LENGTH,
  PIN_ROLES,
  TERMINAL_SETTINGS,
} from "./settings";
export {
  TERMINAL_CLONED_NOTICE,
  TERMINAL_LOCKED_NOTICE,
  TERMINAL_NOTIFICATION_TYPES,
} from "./notices";
