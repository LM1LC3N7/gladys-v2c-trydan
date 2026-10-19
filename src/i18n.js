// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature, status and mode names, the
// status of the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { CHARGE_STATE, FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('V2C Trydan', 'V2C Trydan');

export const FEATURE_NAMES = {
  [FEATURES.STATUS]: both('Status', 'État'),
  [FEATURES.CONNECTOR]: both('Connector', 'Connecteur'),
  [FEATURES.CHARGING_STATE]: both('Charging state', 'État de charge'),
  [FEATURES.PLUGGED]: both('Vehicle plugged in', 'Véhicule branché'),
  [FEATURES.CHARGE_POWER]: both('Charging power', 'Puissance de charge'),
  [FEATURES.HOUSE_POWER]: both('House power', 'Puissance de la maison'),
  [FEATURES.SOLAR_POWER]: both('Solar power', 'Puissance solaire'),
  [FEATURES.BATTERY_POWER]: both('Battery power', 'Puissance de la batterie'),
  [FEATURES.VOLTAGE]: both('Installation voltage', "Tension de l'installation"),
  [FEATURES.SESSION_ENERGY]: both('Energy of the session', 'Énergie de la session'),
  [FEATURES.SESSION_DURATION]: both('Duration of the session', 'Durée de la session'),
  [FEATURES.INTENSITY]: both('Charging current', 'Courant de charge'),
  [FEATURES.MIN_INTENSITY]: both('Minimum current', 'Courant minimal'),
  [FEATURES.MAX_INTENSITY]: both('Maximum current', 'Courant maximal'),
  [FEATURES.PAUSED]: both('Charge paused', 'Charge en pause'),
  [FEATURES.LOCKED]: both('Station locked', 'Borne verrouillée'),
  [FEATURES.TIMER]: both('Schedule on', 'Programmation active'),
  [FEATURES.DYNAMIC]: both('Dynamic modulation', 'Modulation dynamique'),
  [FEATURES.PAUSE_DYNAMIC]: both('Modulation paused', 'Modulation en pause'),
  [FEATURES.READY]: both('Ready', 'Prête'),
  [FEATURES.CHARGE_MODE]: both('Wiring (phases)', 'Câblage (phases)'),
  [FEATURES.SOLAR_MODE]: both('Solar control mode', 'Mode de pilotage solaire'),
  [FEATURES.METER]: both('Meter link', 'Liaison du compteur'),
  [FEATURES.PAUSE]: both('Pause charging', 'Mettre la charge en pause'),
  [FEATURES.RESUME]: both('Resume charging', 'Reprendre la charge'),
  [FEATURES.SET_INTENSITY]: both('Set the charging current', 'Régler le courant de charge'),
  [FEATURES.SET_SOLAR_MODE]: both('Set the solar control mode', 'Régler le pilotage solaire'),
};

export const STATUS_NAMES = {
  [CHARGE_STATE.NOT_CONNECTED]: both('No vehicle', 'Aucun véhicule'),
  [CHARGE_STATE.CONNECTED]: both('Plugged in, not charging', 'Branché, pas en charge'),
  [CHARGE_STATE.CHARGING]: both('Charging', 'En charge'),
  [CHARGE_STATE.LEAK_OR_PILOT_SHORT]: both(
    'Fault: leak or pilot short circuit',
    'Défaut : fuite ou court-circuit du pilote',
  ),
  [CHARGE_STATE.PILOT_OR_GROUND_FAULT]: both(
    'Fault: control pilot or ground',
    'Défaut : pilote ou terre',
  ),
  [CHARGE_STATE.VENTILATION]: both(
    'Charging (ventilation required)',
    'En charge (ventilation requise)',
  ),
  paused: both('Plugged in, paused', 'Branché, en pause'),
  locked: both('Station locked', 'Borne verrouillée'),
  unknown: both('Unknown state', 'État inconnu'),
  offline: both('Station unreachable', 'Borne injoignable'),
};

export const CHARGE_MODE_NAMES = {
  'single-phase': both('Single-phase', 'Monophasé'),
  'three-phase': both('Three-phase', 'Triphasé'),
  mixed: both('Mixed', 'Mixte'),
};

export const SOLAR_MODE_NAMES = {
  timed: both('Schedule (app or V2C cloud)', 'Programmation (application ou cloud V2C)'),
  'timed-off': both('No schedule', 'Sans programmation'),
  'solar-min': both('Solar + minimum power', 'Solaire + puissance minimale'),
  'solar-only': both('Solar only', 'Solaire seul'),
  'solar-grid': both('Solar + grid', 'Solaire + réseau'),
  stop: both('Stop', 'Arrêt'),
};

/** SlaveError of pytrydan: the link to the meter (clamp, inverter) of the station. */
export function meterName(code) {
  const names = {
    0: both('No error', 'Sans erreur'),
    1: both('Communication error', 'Erreur de communication'),
    2: both('Reading error', 'Erreur de lecture'),
    3: both('Meter error', 'Erreur du compteur'),
    4: both('Waiting for Wi-Fi', 'Attente du Wi-Fi'),
    5: both('Waiting for communication', 'Attente de communication'),
    6: both('Wrong IP address', 'Mauvaise adresse IP'),
    7: both('Meter not found', 'Compteur introuvable'),
    8: both('Wrong meter', 'Mauvais compteur'),
    9: both('No response', 'Pas de réponse'),
    10: both('Clamp not connected', 'Pince non branchée'),
  };
  if (Object.hasOwn(names, code)) {
    return names[code];
  }
  if ((code >= 21 && code <= 32) || (code >= 245 && code <= 257)) {
    return both(`Modbus error ${code}`, `Erreur Modbus ${code}`);
  }
  return both(`Error ${code}`, `Erreur ${code}`);
}

/** The integration status, the button and the logs a user may read. */
export const T = {
  noAddress: both(
    'Enter the IP address of your V2C Trydan, then save.',
    "Saisissez l'adresse IP de votre V2C Trydan, puis enregistrez.",
  ),
  /** `entries`: `{ text, reason: 'invalid' | 'not_unicast' | 'too_many' }` from normalizeConfig. */
  invalid: (entries) => {
    const reasons = {
      too_many: both('four at most', 'quatre au plus'),
      not_unicast: both('not a unicast address', "pas une adresse d'appareil"),
    };
    const list = (language) =>
      entries
        .map(({ text, reason }) =>
          reasons[reason] ? `${text} (${word(reasons[reason], language)})` : text,
        )
        .join(', ');
    return both(`Address ignored: ${list('en')}.`, `Adresse ignorée : ${list('fr')}.`);
  },
  orphans: (names) =>
    both(
      `Not read any more: ${names} (address removed or not answering).`,
      `Plus lue : ${names} (adresse retirée ou sans réponse).`,
    ),
  connecting: both('Reading the station…', 'Lecture de la borne…'),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (list, wait) =>
    both(
      `No answer from ${list} (next try in ${wait.en}). Check the address and that the station is on the network.`,
      `Pas de réponse de ${list} (nouvel essai dans ${wait.fr}). Vérifiez l'adresse et que la borne est sur le réseau.`,
    ),
  rateLimited: (wait) =>
    both(
      `The station asks to slow down (HTTP 429): pause of ${wait.en}.`,
      `La borne demande de ralentir (HTTP 429) : pause de ${wait.fr}.`,
    ),
  notApplied: (name, kinds) =>
    both(
      `${name} accepted ${kinds.en} without applying it (solar control, schedule or setting of the station?).`,
      `${name} a accepté ${kinds.fr} sans l'appliquer (pilotage solaire, programmation ou réglage de la borne ?).`,
    ),
  kinds: {
    paused: both('the pause or resume', 'la pause ou la reprise'),
    intensity: both('the charging current', 'le courant de charge'),
    mode: both('the solar control mode', 'le mode de pilotage solaire'),
  },
  test: {
    cooldown: both('Tested less than 10 s ago.', 'Testé il y a moins de 10 s.'),
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    "Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l'intégration.",
  ),
  unknownStation: both(
    'This station is not read by the integration (address missing or not answering).',
    "Cette borne n'est pas lue par l'intégration (adresse absente ou sans réponse).",
  ),
  otherStation: both(
    'Another station answers at this address now: command refused, not sent.',
    'Une autre borne répond maintenant à cette adresse : commande refusée, non envoyée.',
  ),
  badButton: both('A button only accepts the value 1.', "Un bouton n'accepte que la valeur 1."),
  badCurrent: both(
    'The charging current must be a whole number of amperes.',
    "Le courant de charge doit être un nombre entier d'ampères.",
  ),
  badMode: both(
    'Unknown solar control mode: not sent.',
    'Mode de pilotage solaire inconnu : non envoyé.',
  ),
  outOfBounds: (min, max) =>
    both(
      `The charging current must be between ${min} and ${max} A for this station: not sent.`,
      `Le courant de charge doit être entre ${min} et ${max} A pour cette borne : non envoyé.`,
    ),
  unknownBounds: both(
    'The station did not give a valid minimum and maximum current: command refused, not sent.',
    "La borne n'a pas donné de courant minimal et maximal valables : commande refusée, non envoyée.",
  ),
  intensityTooOften: (wait) =>
    both(
      `One change of the charging current a minute at most: try again in ${wait.en}. "Pause charging" stays available. Not sent.`,
      `Un changement du courant de charge par minute au plus : réessayez dans ${wait.fr}. « Mettre la charge en pause » reste disponible. Non envoyé.`,
    ),
  paused: (wait) =>
    both(
      `The station asked to slow down: commands paused for ${wait.en}.`,
      `La borne a demandé de ralentir : commandes en pause pendant ${wait.fr}.`,
    ),
  stillRunning: both(
    'Another command of this station is still running: not sent.',
    'Une autre commande de cette borne est encore en cours : non envoyée.',
  ),
  pauseMeanwhile: both(
    'A pause of this station arrived meanwhile: this command is not sent.',
    "Une pause de cette borne est arrivée entre-temps : cette commande n'est pas envoyée.",
  ),
  tooSlow: both(
    'The station answered too slowly to send the command in time: not sent.',
    'La borne a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the station could not be read just before (${reason}): command not sent.`,
      `L'état de la borne n'a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  missing: both(
    'The station did not give the state this command needs: not sent.',
    "La borne n'a pas donné l'état dont cette commande a besoin : non envoyée.",
  ),
  fault: (status) =>
    both(
      `The station reports "${status.en}": charging is not resumed. Not sent.`,
      `La borne signale « ${status.fr} » : la charge n'est pas reprise. Non envoyée.`,
    ),
  unknownStatus: both(
    'The state of the station is unknown: charging is not resumed. Not sent.',
    "L'état de la borne est inconnu : la charge n'est pas reprise. Non envoyée.",
  ),
  notSent: (reason) =>
    both(
      `The station could not be reached (${reason}): command not sent.`,
      `La borne n'a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The station refused the command (${reason}).`,
      `La borne a refusé la commande (${reason}).`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the station in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l'état de la borne dans quelques secondes.`,
    ),
};

/** The one-line summary of a station: "V2C Trydan 1a2b: Charging, 2664 W, 12 A". */
export function summaryOf({ name, status, power, intensity }) {
  const en = [status.en];
  const fr = [status.fr];
  if (power !== undefined) {
    en.push(`${power} W`);
    fr.push(`${power} W`);
  }
  if (intensity !== undefined) {
    en.push(`${intensity} A`);
    fr.push(`${intensity} A`);
  }
  return both(`${name}: ${en.join(', ')}.`, `${name} : ${fr.join(', ')}.`);
}
