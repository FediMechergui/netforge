/** capture/filter/fields/syslog.ts — syslog display fields ([S25]; ARCHITECTURE-P3 §2.3, §3.7; W2 capture). */
import { protoDisplayFields } from './kit.js';

export const SYSLOG_DISPLAY_FIELDS = protoDisplayFields({
  help: { syslog: 'Syslog (UDP 514): one log message with its priority, timestamp and sender name.' },
  aliases: [
    { name: 'syslog.level', reads: ['syslog.severity'], help: 'Severity: 0 emergencies, 1 alerts, 2 critical, 3 errors, 4 warnings, 5 notifications, 6 informational, 7 debugging (syslog.severity).' },
    { name: 'syslog.msg', reads: ['syslog.message'], help: 'Text of the log message (syslog.message).' },
  ],
});
