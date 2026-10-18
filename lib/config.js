'use strict';

// Single source of truth for workflow vocabulary and limits.
// Change statuses/severities/label presets here if your team's process differs.

const intEnv = (name, fallback) => {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};

const AUTO_HOLD_DAYS = intEnv('AUTO_HOLD_DAYS', 3);

const META = {
  statuses: [
    { value: 'Ongoing', color: '#e5484d' },
    { value: 'Monitoring', color: '#f5a524' },
    // On Hold can be set by hand AND is applied automatically (store.autoHoldStale)
    { value: 'On Hold', color: '#6b7280' },
    { value: 'Completed', color: '#30a46c' },
  ],
  severities: ['Show-stopper', 'Critical', 'High', 'Error'], // most to least severe
  defaultSeverity: 'High',
  labelPresets: ['Issue Occurred', 'Identified', 'Update', 'RCA', 'Completion'],
  modes: [
    {
      value: 'takecare',
      label: 'Assigned with take care',
      hint: 'The assigned person works on it. Anyone signed in can press "Take care" to add timeline events without being assigned, and several people can do so at once. If you assign it to nobody, then anyone can, and only the assignee, the creator and super users can change the status.',
    },
    {
      value: 'anyone',
      label: 'Assigned to anyone',
      hint: 'You can assign it to any teammate. Anyone signed in can assign an unassigned alert to themselves.',
    },
    {
      value: 'private',
      label: 'Only me',
      hint: 'Only you and super users can work on it. Nobody else can be assigned or take care of it.',
    },
  ],
  defaultMode: 'takecare',
  autoHoldDays: AUTO_HOLD_DAYS,
};

// Older backups / databases used these names.
const LEGACY_SEVERITY = { SEV1: 'Show-stopper', SEV2: 'Critical', SEV3: 'High', SEV4: 'Error' };
const LEGACY_MODE = { open: 'anyone' };

module.exports = {
  META,
  STATUS_VALUES: META.statuses.map((s) => s.value),
  SEVERITY_VALUES: META.severities,
  DONE_STATUS: 'Completed',
  AUTO_STATUS: 'On Hold',      // also applied by the system after AUTO_HOLD_DAYS without a timeline update
  RESUME_STATUS: 'Ongoing',    // an AUTOMATICALLY held alert returns here when someone adds an update
  AUTO_HOLD_DAYS,
  LEGACY_SEVERITY,
  LEGACY_MODE,
  DEFAULT_ADMIN_PASSWORD: 'admin123',

  ROLES: ['user', 'superuser'],
  MODES: META.modes.map((m) => m.value),
  MODE_LABEL: Object.fromEntries(META.modes.map((m) => [m.value, m.label])),

  LIMITS: {
    title: 200,
    description: 5000,
    label: 80,
    note: 5000,
    linkName: 80,
    linkUrl: 2000,
    linksPerItem: 20,
    usernameMin: 3,
    usernameMax: 32,
    passwordMin: 8,
    passwordMax: 128,
  },

  PORT: process.env.PORT === '0' ? 0 : intEnv('PORT', 3000),
  HOST: process.env.HOST || '0.0.0.0',
  SESSION_HOURS: intEnv('SESSION_HOURS', 168), // 7 days
  COOKIE_NAME: 'sre_session',
  COOKIE_SECURE: process.env.COOKIE_SECURE === '1', // set when serving over HTTPS
  TRUST_PROXY: process.env.TRUST_PROXY === '1',     // set when behind nginx/ALB
  QUIET: process.env.QUIET === '1',

  BODY_LIMIT: 1_000_000,          // 1 MB for normal API calls
  IMPORT_BODY_LIMIT: 25_000_000,  // 25 MB for backup imports
};
