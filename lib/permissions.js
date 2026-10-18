'use strict';

const { DONE_STATUS } = require('./config');

// Single source of truth - the API enforces these, the UI only reflects them.
//
//  Anonymous visitor : read-only.
//  Super user        : everything, except assigning inside an "Only me" alert (change its mode first).
//  Alert creator     : edit, change status, add/edit/delete timeline events, assign to anyone, delete.
//  Assignee          : the same as the creator, except deleting the alert and changing its mode.
//
//  ASSIGNED is exclusive: an alert has at most one assignee. Once somebody is assigned, only the
//  super user, the creator and the assignee can change the assignment or the status.
//
//  TAKING CARE is shared: anyone signed in can press "Take care", as many people as want to. It lets
//  them ADD timeline events and nothing else. It never assigns them and never asks them to assign.
//
//  Modes
//    takecare ("Assigned with take care", default)
//        If it was created with "Nobody yet", then while nobody is assigned anyone signed in sees both
//        "Assign to me" and "Take care". Assigned alerts can still be taken care of by anyone.
//    anyone ("Assigned to anyone")
//        The creator/assignee/super user can assign it to anyone. Anyone signed in can assign an
//        UNASSIGNED alert to themselves. No take care.
//    private ("Only me")
//        Only the creator and super users. Nobody else can be assigned or take care.
//
//  Completed alerts cannot be assigned to yourself or taken care of, and carers can no longer add
//  events to them.

const same = (a, b) => !!a && !!b && String(a).toLowerCase() === String(b).toLowerCase();
const isSuper = (user) => !!user && user.role === 'superuser';

const NONE = {
  canEdit: false, canAddEvent: false, canAssign: false, canAssignSelf: false,
  canTakeCare: false, canLeaveCare: false, canDelete: false, canChangeMode: false,
};

function incidentPermissions(incident, user) {
  if (!user) return { ...NONE };

  const sup = isSuper(user);
  const creator = same(incident.created_by, user.username);
  const assignee = same(incident.assignee, user.username);
  const carer = (incident.carers || []).some((c) => same(c, user.username));
  const collaborative = incident.mode !== 'private';
  const done = incident.status === DONE_STATUS;

  const canEdit = sup || creator || (collaborative && assignee);

  return {
    canEdit,
    canAddEvent: canEdit || (incident.mode === 'takecare' && carer && !done),
    canAssign: collaborative && (sup || creator || assignee),
    // "anyone" mode: any unassigned alert. Take-care mode: only alerts created with "Nobody yet"
    // (single_holder = open for pickup) and still unassigned.
    canAssignSelf: !done && !incident.assignee && (
      incident.mode === 'anyone' || (incident.mode === 'takecare' && !!incident.single_holder)
    ),
    canTakeCare: incident.mode === 'takecare' && !done && !canEdit && !carer,
    canLeaveCare: carer,
    canDelete: sup || creator,
    canChangeMode: sup || creator,
  };
}

module.exports = { incidentPermissions, isSuper, same };
