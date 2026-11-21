export const strategies: Record<string, { name: string; description: string }> = {
  MIN_DELAY: { name: 'Najmanj zamud', description: 'Poudarek na želenih prihodih, z večjo težo pri nalogah P1.' },
  MIN_CHANGES: { name: 'Najmanj sprememb', description: 'Prednost imajo obstoječa vozila, zaporedje in časi prevzemov.' },
  MAX_BUFFER: { name: 'Največ rezerve', description: 'Poveča najmanjšo razpoložljivo rezervo v zaporedju nalog.' },
};

export const issueLabels: Record<string, string> = {
  VEHICLE_UNAVAILABLE: 'Vozilo ni operativno',
  NO_COMPATIBLE_VEHICLE: 'Ni vozila z ustrezno opremo, tipom in kapaciteto',
  UNREACHABLE_ROUTE: 'Relacija je nedosegljiva',
  HARD_TIME_WINDOW: 'Obveznega časovnega okna ni mogoče ohraniti',
  INVALID_TRAVEL_TIME: 'Motnja je spremenila čas vožnje',
  FACILITY_NOT_ACCEPTING: 'Ustanova ne sprejema novih prihodov',
  FACILITY_CAPACITY: 'Simulirana kvota ustanove je porabljena',
  MANUAL_COORDINATION: 'Prevoz poteka. Potrebna je ročna koordinacija.',
  LOCKED_EXECUTION_BLOCKED: 'Začeta ali zaklenjena dodelitev je blokirana',
  NOT_SCHEDULED_WITHIN_BUDGET: 'Izračun naloge ni umestil v razpored',
};

export const incidentLabels: Record<string, string> = {
  VEHICLE_BREAKDOWN: 'Okvara vozila', VEHICLE_UNAVAILABLE: 'Nedosegljivo vozilo',
  TRAFFIC_DELAY: 'Zastoj', ROAD_CLOSURE: 'Zapora', WEATHER_DELAY: 'Vremenska motnja',
  NEW_TASK: 'Nova naloga', FACILITY_CAPACITY_CHANGE: 'Sprememba sprejemne kvote',
};
