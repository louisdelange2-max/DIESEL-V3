const { onDocumentWritten } = require("firebase-functions/v2/firestore");
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { logger } = require("firebase-functions");
const { initializeApp } = require("firebase-admin/app");
const {
  getFirestore,
  FieldValue,
  Timestamp,
} = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

const DIESEL_SHEETS_URL =
  "https://script.google.com/macros/s/AKfycbzYuWh2xN4eCjeH7iiU13bnJyyGuvy2K4MoyeFpSTQB53CVm6jRqX8hyxDt-ePCIJ5Q8w/exec";

const MIRROR_META_FIELDS = new Set([
  "sheetMirrorStatus","sheetMirroredAt","sheetMirrorError","sheetMirrorAttempts",
  "sheetMirrorLastAttemptAt","sheetMirrorLastResult",
]);

function stripMirrorMetadata(data) {
  const copy = {};
  for (const [k,v] of Object.entries(data || {})) {
    if (!MIRROR_META_FIELDS.has(k)) copy[k] = v;
  }
  return copy;
}
function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === "object") {
    if (typeof value.toMillis === "function") return { __timestampMillis:value.toMillis() };
    const out = {};
    for (const k of Object.keys(value).sort()) out[k] = stableValue(value[k]);
    return out;
  }
  return value;
}
function businessDataChanged(beforeData, afterData) {
  if (!beforeData) return true;
  return JSON.stringify(stableValue(stripMirrorMetadata(beforeData))) !==
    JSON.stringify(stableValue(stripMirrorMetadata(afterData)));
}
async function postJson(url, body) {
  const response = await fetch(url, {
    method:"POST",
    headers:{ "Content-Type":"text/plain;charset=utf-8" },
    body:JSON.stringify(body),
  });
  const text = await response.text();
  let result = {};
  try { result = text ? JSON.parse(text) : {}; }
  catch (e) { throw new Error(`Non-JSON backend response: ${text.slice(0,250)}`); }
  if (!response.ok || result.status === "error" || result.ok === false) {
    throw new Error(result.message || result.error || `HTTP ${response.status}`);
  }
  return result;
}
function norm(value) { return String(value || "").trim(); }
function normKey(value) {
  return norm(value).toLowerCase().replace(/[^a-z0-9]+/g,"_").replace(/^_+|_+$/g,"") || "unknown";
}

function normalizeCompanyName(value) {
  return norm(value).toLowerCase().replace(/\s+/g, " ");
}

function extractAllowedCompanies(machine) {
  const sourceFields = [
    machine.allowedDieselCompanies,
    machine.allowedCompanies,
    machine.companiesAllowedToFill,
    machine.allowedToFill,
    machine.allowedCompanyNames,
    machine.dieselAllowedCompanies,
  ];

  const values = [];
  for (const source of sourceFields) {
    if (Array.isArray(source)) {
      values.push(...source);
      continue;
    }
    if (source && typeof source === "object") {
      for (const [key, enabled] of Object.entries(source)) {
        if (enabled === true || String(enabled).toLowerCase() === "true") values.push(key);
      }
      continue;
    }
    if (typeof source === "string") {
      values.push(...source.split(/[,;|\n]+/));
    }
  }

  const unique = [];
  const seen = new Set();
  for (const value of values) {
    const clean = norm(value);
    const key = normalizeCompanyName(clean);
    if (!clean || seen.has(key)) continue;
    seen.add(key);
    unique.push(clean);
  }

  // Older machine documents may only contain the owner company. Use that only
  // when no explicit allowed-company field exists.
  if (!unique.length) {
    const owner = norm(machine.ownerCompany || machine.companyName || machine.owner || "");
    if (owner) unique.push(owner);
  }

  return unique;
}

function balanceId(bowser, company) { return `${normKey(bowser)}__${normKey(company)}`; }
function debtId(debtor, creditor) { return `${normKey(debtor)}__owes__${normKey(creditor)}`; }
function isOtherBowser(name) { return norm(name).toLowerCase() === "other"; }
function isKmMachine(type) {
  return ["truck","bakkie","trokkie","fortuner"].includes(norm(type).toLowerCase());
}
function actionNeedsOtp(type) {
  return ["bowser_receive","bowser_transfer","intercompany_transfer","company_settlement"].includes(type);
}
function saDateText(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone:"Africa/Johannesburg", year:"numeric", month:"2-digit", day:"2-digit"
  }).format(date);
}
function saNowText(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone:"Africa/Johannesburg", year:"numeric", month:"2-digit", day:"2-digit",
    hour:"2-digit", minute:"2-digit", second:"2-digit", hour12:false
  }).formatToParts(date).filter(p => p.type !== "literal")
    .reduce((o,p) => (o[p.type]=p.value,o), {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}`;
}
function addDays(iso, days) {
  const [y,m,d] = iso.split("-").map(Number);
  const dt = new Date(Date.UTC(y,m-1,d));
  dt.setUTCDate(dt.getUTCDate()+days);
  return dt.toISOString().slice(0,10);
}
async function getAllowedUserFromRequest(request) {
  if (!request.auth) throw new HttpsError("unauthenticated","Sign in required.");
  const phone = norm(request.auth.token.phone_number);
  if (!phone) throw new HttpsError("permission-denied","Authenticated phone number missing.");
  const snap = await db.collection("allowedUsers").doc(phone).get();
  if (!snap.exists || snap.data().active === false) throw new HttpsError("permission-denied","User is not active in Allowed Users.");
  return { phone, uid:request.auth.uid, ...snap.data() };
}
function requireAdmin(user) {
  if (String(user.role || "user").toLowerCase() !== "admin") {
    throw new HttpsError("permission-denied","Admin access required.");
  }
}

// ------------------------------------------------------------------
// Diesel OTP
// ------------------------------------------------------------------
exports.requestDieselOtp = onCall({ region:"africa-south1" }, async request => {
  const user = await getAllowedUserFromRequest(request);
  const actionName = norm(request.data?.actionName).toLowerCase();
  if (!actionNeedsOtp(actionName)) throw new HttpsError("invalid-argument","Invalid OTP action.");
  const code = String(Math.floor(100000 + Math.random()*900000));
  const now = Date.now();
  const expiresMs = now + 10*60*1000;
  const ref = db.collection("dieselOtpRequests").doc();
  await ref.set({
    actionName,
    code,
    status:"active",
    requestedByUid:user.uid,
    requestedByName:user.name || "User",
    requestedByPhone:user.phone,
    createdAt:FieldValue.serverTimestamp(),
    createdAtMs:now,
    expiresAt:Timestamp.fromMillis(expiresMs),
    expiresAtText:saNowText(new Date(expiresMs)),
  });
  return { ok:true, requestId:ref.id, expiresInMinutes:10 };
});

exports.verifyDieselOtp = onCall({ region:"africa-south1" }, async request => {
  const user = await getAllowedUserFromRequest(request);
  const requestId = norm(request.data?.requestId);
  const actionName = norm(request.data?.actionName).toLowerCase();
  const code = norm(request.data?.code);
  if (!requestId || !actionName || !code) throw new HttpsError("invalid-argument","OTP request, action and code are required.");
  const ref = db.collection("dieselOtpRequests").doc(requestId);
  await db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError("not-found","OTP request not found.");
    const data = snap.data() || {};
    if (data.requestedByUid !== user.uid) throw new HttpsError("permission-denied","This OTP belongs to another user.");
    if (data.actionName !== actionName) throw new HttpsError("failed-precondition","OTP action does not match.");
    if (data.status !== "active") throw new HttpsError("failed-precondition","OTP is already used or inactive.");
    if (data.expiresAt?.toMillis?.() < Date.now()) throw new HttpsError("deadline-exceeded","OTP has expired.");
    if (String(data.code || "") !== code) throw new HttpsError("permission-denied","Invalid OTP code.");
    tx.set(ref, { status:"used", usedAt:FieldValue.serverTimestamp() }, { merge:true });
  });
  return { valid:true, message:"OTP accepted." };
});

async function validateOtpInsideTransaction(tx, user, requestId, actionName, code, entryId) {
  if (!actionNeedsOtp(actionName)) return null;
  const ref = db.collection("dieselOtpRequests").doc(requestId);
  const snap = await tx.get(ref);
  if (!snap.exists) throw new HttpsError("not-found","Request a new OTP first.");
  const data = snap.data() || {};
  if (data.requestedByUid !== user.uid) throw new HttpsError("permission-denied","OTP belongs to another user.");
  if (data.actionName !== actionName) throw new HttpsError("failed-precondition","OTP action mismatch.");
  if (data.status !== "active") throw new HttpsError("failed-precondition","OTP is already used.");
  if (data.expiresAt?.toMillis?.() < Date.now()) throw new HttpsError("deadline-exceeded","OTP has expired.");
  if (String(data.code || "") !== String(code || "")) throw new HttpsError("permission-denied","Invalid OTP code.");

  // IMPORTANT: only READ/validate here.
  // Firestore transactions require all reads to complete before any write.
  return { ref, entryId };
}


// ------------------------------------------------------------------
// Admin machine master save + authoritative latest reading correction
// ------------------------------------------------------------------
exports.saveDieselAdminMachine = onCall({ region:"africa-south1" }, async request => {
  const user = await getAllowedUserFromRequest(request);
  requireAdmin(user);

  const data = request.data || {};
  const machineType = norm(data.machineType);
  const plantNumber = norm(data.plantNumber);
  const machineModel = norm(data.machineModel);
  const regNum = norm(data.regNum);
  const ownerCompany = norm(data.ownerCompany || data.companyName);
  const allowedDieselCompanies = extractAllowedCompanies({
    allowedDieselCompanies:data.allowedDieselCompanies
  });
  const active = data.active !== false;
  const latestReadingRaw = data.latestReading;
  const latestReading =
    latestReadingRaw === null || latestReadingRaw === undefined || String(latestReadingRaw).trim() === ""
      ? null
      : Number(latestReadingRaw);

  if (!machineType || (!plantNumber && !regNum) || !ownerCompany || !allowedDieselCompanies.length) {
    throw new HttpsError("invalid-argument","Enter machine details, owner and at least one allowed company.");
  }
  if (latestReading !== null && (!Number.isFinite(latestReading) || latestReading < 0)) {
    throw new HttpsError("invalid-argument","Latest machine hours/KM must be a valid non-negative number.");
  }

  const canonicalKey = normKey(plantNumber || regNum);
  if (!canonicalKey) throw new HttpsError("invalid-argument","Machine identity is invalid.");

  const machinesRef = db.collection("dieselMachines");
  const allSnap = await machinesRef.get();
  const plantKey = normKey(plantNumber);
  const regKey = normKey(regNum);
  const matchingDocs = allSnap.docs.filter(doc => {
    const row = doc.data() || {};
    return (plantKey && normKey(row.plantNumber) === plantKey) ||
           (regKey && normKey(row.regNum) === regKey) ||
           doc.id === norm(data.editingId);
  });

  // Safe admin edit: update the document that was actually selected.
  // If there is no valid editing document, reuse an existing matching machine.
  // Only create the canonical document for a genuinely new machine.
  const requestedEditingId = norm(data.editingId);
  const selectedEditingDoc = requestedEditingId
    ? matchingDocs.find(doc => doc.id === requestedEditingId)
    : null;
  const targetDoc = selectedEditingDoc || matchingDocs[0] || null;
  const targetRef = targetDoc ? targetDoc.ref : machinesRef.doc(canonicalKey);
  const batch = db.batch();
  batch.set(targetRef, {
    machineType,
    plantNumber,
    machineModel,
    regNum,
    ownerCompany,
    companyName:ownerCompany,
    allowedDieselCompanies,
    active,
    latestReadingOverride:latestReading,
    latestReadingType:isKmMachine(machineType) ? "km" : "hours",
    latestReadingEditedAt:FieldValue.serverTimestamp(),
    latestReadingEditedBy:user.phone || user.uid || "",
    updatedAt:FieldValue.serverTimestamp(),
  }, { merge:true });

  // Never delete machine master documents during a normal admin save.
  // Duplicate cleanup must be a separate, explicit admin operation.

  if (latestReading !== null) {
    if (isKmMachine(machineType)) {
      const stateId = normKey(regNum || plantNumber);
      batch.set(db.collection("dieselTruckStates").doc(stateId), {
        regNum:regNum || plantNumber,
        latestKm:latestReading,
        latestEntryId:null,
        adminCorrected:true,
        adminCorrectedAt:FieldValue.serverTimestamp(),
        adminCorrectedBy:user.phone || user.uid || "",
        updatedAt:FieldValue.serverTimestamp(),
      }, { merge:true });
    } else {
      batch.set(db.collection("dieselMachineStates").doc(normKey(plantNumber)), {
        plantNumber,
        latestHours:latestReading,
        latestEntryId:null,
        adminCorrected:true,
        adminCorrectedAt:FieldValue.serverTimestamp(),
        adminCorrectedBy:user.phone || user.uid || "",
        updatedAt:FieldValue.serverTimestamp(),
      }, { merge:true });
    }
  }

  await batch.commit();

  return {
    ok:true,
    machineId:targetRef.id,
    removedDuplicateCount:0,
    latestReading,
  };
});

// ------------------------------------------------------------------
// Diesel authoritative save + balances/latest readings
// ------------------------------------------------------------------
exports.saveDieselEntry = onCall({ region:"africa-south1", timeoutSeconds:60 }, async request => {
  const user = await getAllowedUserFromRequest(request);
  const raw = request.data?.entry || {};
  const entryId = norm(raw.id);
  const type = norm(raw.transactionType || "machine_fill").toLowerCase();
  if (!entryId) throw new HttpsError("invalid-argument","Entry ID is required.");

  const backdateDays = Number.isFinite(Number(user.dieselBackdateDays)) ? Math.max(0, Math.floor(Number(user.dieselBackdateDays))) : 1;
  const today = saDateText();
  const minDate = addDays(today, -backdateDays);
  const entryDate = norm(raw.entryDate);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) throw new HttpsError("invalid-argument","Valid entry date is required.");
  if (entryDate > today) throw new HttpsError("failed-precondition","Entry date cannot be later than today.");
  if (entryDate < minDate) throw new HttpsError("failed-precondition",`You can only backdate Diesel entries by ${backdateDays} day${backdateDays === 1 ? "" : "s"}.`);

  const entry = {
    ...raw,
    id:entryId,
    transactionType:type,
    userName:user.name || "User",
    capturedByUid:user.uid,
    capturedByName:user.name || "User",
    capturedByPhone:user.phone,
    createdAtText:raw.createdAtText || saNowText(),
    updatedAtText:saNowText(),
    deviceSavedAt:raw.deviceSavedAt || saNowText(),
    sheetMirrorStatus:"pending",
    sheetMirrorError:"",
  };

  if (type === "machine_fill") {
    entry.sourceCompanyName = entry.companyName || "";
    if (!norm(entry.siteName)) throw new HttpsError("invalid-argument","Site is required.");
    if (!norm(entry.companyName)) throw new HttpsError("invalid-argument","Company is required.");
    if (!norm(entry.plantNumber)) throw new HttpsError("invalid-argument","Plant Number is required.");
    if (!norm(entry.bowserName)) throw new HttpsError("invalid-argument","Bowser is required.");
    if (Number(entry.dieselFilled || 0) <= 0) throw new HttpsError("invalid-argument","Diesel filled must be more than 0.");

    // Machine master documents are not guaranteed to use the normalized plant number
    // as their Firestore document ID. Admin edits may preserve an older/random document ID.
    // Resolve by any supplied document ID first, then normalized ID, and finally by
    // normalized plantNumber/regNum fields so a valid selected machine is not rejected.
    const machineCollection = db.collection("dieselMachines");
    const candidateMachineIds = [
      raw.machineId,
      raw.machineDocId,
      raw.firestoreMachineId,
      raw.selectedMachineId,
      normKey(entry.plantNumber),
    ].map(norm).filter(Boolean);

    let machineSnap = null;
    const checkedMachineIds = new Set();
    for (const candidateId of candidateMachineIds) {
      if (checkedMachineIds.has(candidateId)) continue;
      checkedMachineIds.add(candidateId);
      const candidateSnap = await machineCollection.doc(candidateId).get();
      if (candidateSnap.exists) {
        machineSnap = candidateSnap;
        break;
      }
    }

    if (!machineSnap) {
      const wantedPlant = normKey(entry.plantNumber);
      const wantedReg = normKey(entry.regNum || entry.registrationNumber || "");
      const allMachinesSnap = await machineCollection.get();
      machineSnap = allMachinesSnap.docs.find(docSnap => {
        const data = docSnap.data() || {};
        const plantMatches = wantedPlant && normKey(data.plantNumber || data.plantNo || data.machineNumber || "") === wantedPlant;
        const regMatches = wantedReg && normKey(data.regNum || data.registrationNumber || data.registration || "") === wantedReg;
        return plantMatches || regMatches;
      }) || null;
    }

    if (!machineSnap) throw new HttpsError("failed-precondition","Machine was not found in Firestore Machine Master.");
    const machine = machineSnap.data() || {};
    entry.machineId = machineSnap.id;
    const allowedCompanies = extractAllowedCompanies(machine);
    const selectedCompanyKey = normalizeCompanyName(entry.companyName);
    if (allowedCompanies.length && !allowedCompanies.some(company => normalizeCompanyName(company) === selectedCompanyKey)) {
      logger.warn("Machine company permission rejected", {
        machineId: machineSnap.id,
        plantNumber: entry.plantNumber,
        selectedCompany: entry.companyName,
        allowedCompanies,
      });
      throw new HttpsError("permission-denied","Selected machine is not allowed for diesel use by the selected company.");
    }
  }

  if (actionNeedsOtp(type)) {
    if (!norm(request.data?.otpRequestId) || !norm(request.data?.otpCode)) {
      throw new HttpsError("failed-precondition","Request and enter a valid one time PIN first.");
    }
  }

  const entryRef = db.collection("dieselEntries").doc(entryId);
  const refsToRead = [];
  const balanceOps = [];
  const debtOps = [];

  function balanceRef(bowser, company) {
    return db.collection("dieselBowserCompanyBalances").doc(balanceId(bowser, company));
  }
  function addDebtOp(debtorCompany, creditorCompany, delta) { if(!debtorCompany||!creditorCompany||debtorCompany===creditorCompany||!delta)return; const ref=db.collection("dieselCompanyDebts").doc(debtId(debtorCompany,creditorCompany)); debtOps.push({ref,debtorCompany,creditorCompany,delta:Number(delta)}); refsToRead.push(ref); }
  function addBalanceOp(bowser, company, delta) {
    if (!bowser || !company || isOtherBowser(bowser) || !delta) return;
    const ref = balanceRef(bowser, company);
    balanceOps.push({ ref, bowser, company, delta:Number(delta) });
    refsToRead.push(ref);
  }

  if (type === "machine_fill") {
    addBalanceOp(entry.bowserName, entry.companyName, -Number(entry.dieselFilled || 0));
  } else if (type === "bowser_receive") {
    if (!norm(entry.receiveBowser) || !norm(entry.companyName) || Number(entry.receivedLiters || 0) <= 0) throw new HttpsError("invalid-argument","Receive bowser, company and liters are required.");
    addBalanceOp(entry.receiveBowser, entry.companyName, Number(entry.receivedLiters || 0));
  } else if (type === "bowser_transfer") {
    if (!norm(entry.fromBowser) || !norm(entry.toBowser) || entry.fromBowser === entry.toBowser || Number(entry.transferredLiters || 0) <= 0) throw new HttpsError("invalid-argument","Valid bowser transfer details are required.");
    addBalanceOp(entry.fromBowser, entry.sourceCompanyName, -Number(entry.transferredLiters || 0));
    addBalanceOp(entry.toBowser, entry.sourceCompanyName, Number(entry.transferredLiters || 0));
  } else if (type === "intercompany_transfer") {
    if (!norm(entry.bowserName) || isOtherBowser(entry.bowserName) || entry.sourceCompanyName === entry.companyName || Number(entry.transferredLiters || 0) <= 0) throw new HttpsError("invalid-argument","Valid intercompany transfer details are required.");
    addBalanceOp(entry.bowserName, entry.sourceCompanyName, -Number(entry.transferredLiters || 0));
    addBalanceOp(entry.bowserName, entry.companyName, Number(entry.transferredLiters || 0));
    addDebtOp(entry.companyName, entry.sourceCompanyName, Number(entry.transferredLiters || 0));
  } else if (type === "company_settlement") {
    if (entry.sourceCompanyName === entry.companyName || Number(entry.transferredLiters || 0) <= 0) throw new HttpsError("invalid-argument","Valid settlement details are required.");
    addDebtOp(entry.sourceCompanyName, entry.companyName, -Number(entry.transferredLiters || 0));
    if (norm(entry.settlementMethod).toLowerCase() === "diesel_balance") {
      if (!norm(entry.bowserName) || isOtherBowser(entry.bowserName)) throw new HttpsError("invalid-argument","Select a bowser for diesel balance settlement.");
      addBalanceOp(entry.bowserName, entry.sourceCompanyName, -Number(entry.transferredLiters || 0));
      addBalanceOp(entry.bowserName, entry.companyName, Number(entry.transferredLiters || 0));
    }
  }

  const machineStateRef = type === "machine_fill" && !isKmMachine(entry.machineType)
    ? db.collection("dieselMachineStates").doc(normKey(entry.plantNumber)) : null;
  const truckStateRef = type === "machine_fill" && isKmMachine(entry.machineType)
    ? db.collection("dieselTruckStates").doc(normKey(entry.regNum)) : null;
  const readingBowserName = type === "machine_fill"
    ? entry.bowserName
    : type === "bowser_transfer"
      ? entry.fromBowser
      : "";
  const bowserStateRef = readingBowserName && !isOtherBowser(readingBowserName)
    ? db.collection("dieselBowserStates").doc(normKey(readingBowserName)) : null;
  const bowserMasterRef = readingBowserName && !isOtherBowser(readingBowserName)
    ? db.collection("dieselBowsers").doc(normKey(readingBowserName)) : null;
  if (machineStateRef) refsToRead.push(machineStateRef);
  if (truckStateRef) refsToRead.push(truckStateRef);
  if (bowserStateRef) refsToRead.push(bowserStateRef);
  if (bowserMasterRef) refsToRead.push(bowserMasterRef);

  let savedEntry = null;
  await db.runTransaction(async tx => {
    const existingSnap = await tx.get(entryRef);
    if (existingSnap.exists) {
      savedEntry = existingSnap.data();
      return;
    }

    let validatedOtp = null;
    if (actionNeedsOtp(type)) {
      validatedOtp = await validateOtpInsideTransaction(
        tx,
        user,
        norm(request.data.otpRequestId),
        type,
        norm(request.data.otpCode),
        entryId
      );
    }

    const uniqueRefs = [];
    const seen = new Set();
    for (const ref of refsToRead) {
      if (!seen.has(ref.path)) { seen.add(ref.path); uniqueRefs.push(ref); }
    }
    const snaps = new Map();
    for (const ref of uniqueRefs) snaps.set(ref.path, await tx.get(ref));

    const currentBalances = new Map();
    for (const op of balanceOps) {
      const snap = snaps.get(op.ref.path);
      const current = snap?.exists ? Number(snap.data().currentLiters || 0) : 0;
      currentBalances.set(op.ref.path, current);
    }

    const nextDebts = new Map();
    for (const op of debtOps) { const snap=snaps.get(op.ref.path); const current=snap?.exists?Number(snap.data().currentLitersOwed||0):0; const next=Math.round((current+op.delta)*100)/100; if(next < -0.01) throw new HttpsError("failed-precondition",`Cannot settle more than owed. ${op.debtorCompany} owes ${op.creditorCompany} ${current.toFixed(2)} L.`); nextDebts.set(op.ref.path, Math.max(0,next)); }

    // Apply balance operations sequentially, checking that outgoing operations never go below zero.
    const nextBalances = new Map(currentBalances);
    for (const op of balanceOps) {
      const current = Number(nextBalances.get(op.ref.path) || 0);
      const next = Math.round((current + op.delta) * 100) / 100;
      if (next < -0.01) {
        throw new HttpsError("failed-precondition",`Not enough diesel for ${op.company} in ${op.bowser}. Available: ${current.toFixed(2)} L`);
      }
      nextBalances.set(op.ref.path, next);
    }

    if (machineStateRef) {
      const snap = snaps.get(machineStateRef.path);
      const previous = snap?.exists ? Number(snap.data().latestHours || 0) : null;
      const current = Number(entry.machineHours || 0);
      if (previous !== null && current < previous) throw new HttpsError("failed-precondition",`Machine hours cannot be lower than ${previous}.`);
    }
    if (truckStateRef) {
      const snap = snaps.get(truckStateRef.path);
      const previous = snap?.exists ? Number(snap.data().latestKm || 0) : null;
      const current = Number(entry.kmReading || 0);
      if (previous !== null && current < previous) throw new HttpsError("failed-precondition",`KM reading cannot be lower than ${previous}.`);
    }
    if (bowserStateRef) {
      const stateSnap = snaps.get(bowserStateRef.path);
      const masterSnap = bowserMasterRef ? snaps.get(bowserMasterRef.path) : null;

      // Normal rule:
      //   previous saved fill CLOSE -> next fill OPEN.
      // If Admin has deliberately corrected the current bowser reading,
      // latestCloseOverride is used once as the authoritative opening.
      const stateReading =
        stateSnap?.exists && stateSnap.data().latestReading !== undefined
          ? Number(stateSnap.data().latestReading)
          : null;

      const overrideRaw =
        masterSnap?.exists ? masterSnap.data().latestCloseOverride : null;
      const overrideReading =
        overrideRaw !== null && overrideRaw !== undefined && String(overrideRaw).trim() !== ""
          ? Number(overrideRaw)
          : null;

      const latestReading =
        Number.isFinite(overrideReading) ? overrideReading :
        Number.isFinite(stateReading) ? stateReading :
        null;

      const open = Number(entry.openBowser || 0);
      const close = Number(entry.closeBowser || 0);

      if (close < open) throw new HttpsError("failed-precondition","Close bowser reading cannot be lower than open bowser reading.");
      if (Number(entry.bowserLitersTaken || entry.dieselFilled || entry.transferredLiters || 0) <= 0) throw new HttpsError("failed-precondition","Bowser liters taken must be more than 0.");
      if (type === "bowser_transfer") {
        const calculatedTransferred = Math.round((close - open) * 100) / 100;
        const submittedTransferred = Math.round(Number(entry.transferredLiters || 0) * 100) / 100;
        if (Math.abs(calculatedTransferred - submittedTransferred) > 0.01) {
          throw new HttpsError("failed-precondition",`Transferred liters must equal source closing minus opening reading (${calculatedTransferred.toFixed(2)} L).`);
        }
      }

      if (latestReading !== null && Math.abs(open - latestReading) > 0.01) {
        throw new HttpsError(
          "aborted",
          `Bowser reading changed. Latest closing reading is ${latestReading}. Refresh and try again.`
        );
      }
    }

    // All transaction reads are complete above. We can safely begin writes now.
    if (validatedOtp?.ref) {
      tx.set(validatedOtp.ref, {
        status:"used",
        usedAt:FieldValue.serverTimestamp(),
        usedByEntryId:entryId
      }, { merge:true });
    }

    tx.set(entryRef, {
      ...entry,
      serverCreatedAt:FieldValue.serverTimestamp(),
      serverUpdatedAt:FieldValue.serverTimestamp(),
    }, { merge:false });

    for (const op of balanceOps) {
      if (op.ref.path !== op.ref.path) continue;
    }
    for (const [path, liters] of nextBalances.entries()) {
      const op = balanceOps.find(x => x.ref.path === path);
      tx.set(op.ref, {
        bowserName:op.bowser,
        companyName:op.company,
        currentLiters:liters,
        updatedAt:FieldValue.serverTimestamp(),
        latestEntryId:entryId,
      }, { merge:true });
    }

    for (const [path, litersOwed] of nextDebts.entries()) { const op=debtOps.find(x=>x.ref.path===path); tx.set(op.ref,{debtorCompany:op.debtorCompany,creditorCompany:op.creditorCompany,currentLitersOwed:litersOwed,latestEntryId:entryId,updatedAt:FieldValue.serverTimestamp()},{merge:true}); }

    if (machineStateRef) tx.set(machineStateRef, {
      plantNumber:entry.plantNumber,
      latestHours:Number(entry.machineHours || 0),
      latestEntryId:entryId,
      entryDate,
      updatedAt:FieldValue.serverTimestamp(),
    }, { merge:true });

    if (truckStateRef) tx.set(truckStateRef, {
      regNum:entry.regNum,
      latestKm:Number(entry.kmReading || 0),
      latestEntryId:entryId,
      entryDate,
      updatedAt:FieldValue.serverTimestamp(),
    }, { merge:true });

    if (bowserStateRef) tx.set(bowserStateRef, {
      bowserName:readingBowserName,
      // IMPORTANT: the saved CLOSE becomes the next fill's OPEN.
      latestReading:Number(entry.closeBowser || 0),
      latestEntryId:entryId,
      entryDate,
      updatedAt:FieldValue.serverTimestamp(),
    }, { merge:true });

    // An Admin correction represents the current opening reading.
    // Once this fill is saved, consume that correction so the new CLOSE
    // becomes authoritative for the following fill.
    if (bowserMasterRef) tx.set(bowserMasterRef, {
      latestCloseOverride:null,
      latestCloseEditedAt:null,
      latestCloseEditedAtText:"",
      latestCloseConsumedByEntryId:entryId,
      updatedAt:FieldValue.serverTimestamp(),
    }, { merge:true });

    savedEntry = entry;
  });

  return { ok:true, entry:savedEntry || entry };
});

// ------------------------------------------------------------------
// Diesel derived-state rebuild after one-time migration
// ------------------------------------------------------------------
exports.rebuildDieselDerivedState = onCall({ region:"africa-south1", timeoutSeconds:540 }, async request => {
  const user = await getAllowedUserFromRequest(request);
  requireAdmin(user);

  const entriesSnap = await db.collection("dieselEntries").get();

  function entryOrderMs(e) {
    const candidates = [
      e.serverCreatedAt,
      e.serverUpdatedAt,
      e.createdAt,
      e.updatedAt
    ];
    for (const value of candidates) {
      if (value && typeof value.toMillis === "function") {
        const ms = Number(value.toMillis());
        if (Number.isFinite(ms) && ms > 0) return ms;
      }
    }

    const textCandidates = [
      e.createdAtText,
      e.deviceSavedAt,
      e.updatedAtText,
      e.entryDate
    ];
    for (const value of textCandidates) {
      const text = norm(value);
      if (!text) continue;
      const ms = Date.parse(text.includes("T") ? text : text.replace(" ", "T"));
      if (Number.isFinite(ms)) return ms;
    }
    return 0;
  }

  const rows = entriesSnap.docs
    .map(doc => ({ id:doc.id, ...doc.data() }))
    .sort((a,b) => {
      const diff = entryOrderMs(a) - entryOrderMs(b);
      return diff || String(a.id || "").localeCompare(String(b.id || ""));
    });

  const balances = new Map();
  const debts = new Map();
  const bowserStates = new Map();
  const machineStates = new Map();
  const truckStates = new Map();

  function addBalance(bowser, company, delta, entryId) {
    if (!bowser || !company || isOtherBowser(bowser)) return;
    const key = balanceId(bowser, company);
    const current = balances.get(key) || { bowserName:bowser, companyName:company, currentLiters:0 };
    current.currentLiters = Math.round((Number(current.currentLiters || 0) + Number(delta || 0))*100)/100;
    current.latestEntryId = entryId;
    balances.set(key,current);
  }

  function addDebt(debtorCompany, creditorCompany, delta, entryId){ if(!debtorCompany||!creditorCompany||debtorCompany===creditorCompany)return; const k=debtId(debtorCompany,creditorCompany),x=debts.get(k)||{debtorCompany,creditorCompany,currentLitersOwed:0}; x.currentLitersOwed=Math.max(0,Math.round((Number(x.currentLitersOwed||0)+Number(delta||0))*100)/100); x.latestEntryId=entryId; debts.set(k,x); }

  for (const e of rows) {
    const type = norm(e.transactionType || "machine_fill").toLowerCase();
    if (type === "machine_fill") {
      addBalance(e.bowserName, e.companyName, -Number(e.dieselFilled || 0), e.id);
      if (!isKmMachine(e.machineType) && e.plantNumber) machineStates.set(normKey(e.plantNumber), {
        plantNumber:e.plantNumber, latestHours:Number(e.machineHours || 0), latestEntryId:e.id, entryDate:e.entryDate || ""
      });
      if (isKmMachine(e.machineType) && e.regNum) truckStates.set(normKey(e.regNum), {
        regNum:e.regNum, latestKm:Number(e.kmReading || 0), latestEntryId:e.id, entryDate:e.entryDate || ""
      });
      if (e.bowserName && !isOtherBowser(e.bowserName)) bowserStates.set(normKey(e.bowserName), {
        bowserName:e.bowserName, latestReading:Number(e.closeBowser || 0), latestEntryId:e.id, entryDate:e.entryDate || ""
      });
    } else if (type === "bowser_receive") {
      addBalance(e.receiveBowser, e.companyName, Number(e.receivedLiters || 0), e.id);
    } else if (type === "bowser_transfer") {
      addBalance(e.fromBowser, e.sourceCompanyName, -Number(e.transferredLiters || 0), e.id);
      addBalance(e.toBowser, e.sourceCompanyName, Number(e.transferredLiters || 0), e.id);
    } else if (type === "intercompany_transfer") {
      addBalance(e.bowserName, e.sourceCompanyName, -Number(e.transferredLiters || 0), e.id);
      addBalance(e.bowserName, e.companyName, Number(e.transferredLiters || 0), e.id);
      addDebt(e.companyName,e.sourceCompanyName,Number(e.transferredLiters||0),e.id);
    } else if (type === "company_settlement") {
      addDebt(e.sourceCompanyName,e.companyName,-Number(e.transferredLiters||0),e.id);
      if (norm(e.settlementMethod).toLowerCase() === "diesel_balance") {
      addBalance(e.bowserName, e.sourceCompanyName, -Number(e.transferredLiters || 0), e.id);
      addBalance(e.bowserName, e.companyName, Number(e.transferredLiters || 0), e.id);
      }
    }
  }

  async function rewriteCollection(name, map) {
    const old = await db.collection(name).get();
    let batch = db.batch(), count = 0;
    for (const doc of old.docs) {
      batch.delete(doc.ref); count++;
      if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
    }
    for (const [id,data] of map.entries()) {
      batch.set(db.collection(name).doc(id), { ...data, updatedAt:FieldValue.serverTimestamp() }, { merge:false });
      count++;
      if (count >= 400) { await batch.commit(); batch = db.batch(); count = 0; }
    }
    if (count) await batch.commit();
  }

  // If Admin has corrected a bowser's CURRENT reading, that correction
  // is authoritative until the next fill consumes it.
  const bowserMasterSnap = await db.collection("dieselBowsers").get();
  for (const doc of bowserMasterSnap.docs) {
    const master = doc.data() || {};
    const name = norm(master.bowserName || master.name || doc.id);
    const raw = master.latestCloseOverride;
    if (!name || raw === null || raw === undefined || String(raw).trim() === "") continue;

    const corrected = Number(raw);
    if (!Number.isFinite(corrected)) continue;

    const key = normKey(name);
    const existing = bowserStates.get(key) || {};
    bowserStates.set(key, {
      ...existing,
      bowserName:name,
      latestReading:corrected,
      latestEntryId:existing.latestEntryId || "",
      entryDate:existing.entryDate || "",
      adminCorrected:true
    });
  }

  await rewriteCollection("dieselBowserCompanyBalances", balances);
  await rewriteCollection("dieselCompanyDebts", debts);
  await rewriteCollection("dieselBowserStates", bowserStates);
  await rewriteCollection("dieselMachineStates", machineStates);
  await rewriteCollection("dieselTruckStates", truckStates);

  return { ok:true, entriesProcessed:rows.length, balances:balances.size, bowsers:bowserStates.size, machines:machineStates.size, trucks:truckStates.size };
});



// ------------------------------------------------------------------
// Admin edit/delete of authoritative Diesel entries
// Firestore remains master; the Firestore mirror trigger updates/deletes Sheets.
// ------------------------------------------------------------------
exports.adminUpdateDieselMachineFill = onCall({ region:"africa-south1", timeoutSeconds:120 }, async request => {
  const user = await getAllowedUserFromRequest(request);
  if (String(user.role || "user").toLowerCase() !== "admin") {
    throw new HttpsError("permission-denied", "Admin access is required.");
  }

  const entryId = norm(request.data?.entryId);
  const changes = request.data?.changes || {};
  if (!entryId) throw new HttpsError("invalid-argument", "Entry ID is required.");

  const ref = db.collection("dieselEntries").doc(entryId);
  const snap = await ref.get();
  if (!snap.exists) throw new HttpsError("not-found", "Diesel entry was not found.");

  const current = snap.data() || {};
  if (norm(current.transactionType || "machine_fill").toLowerCase() !== "machine_fill") {
    throw new HttpsError("failed-precondition", "Only machine fill entries can be edited here.");
  }

  const numericFields = [
    "machineHours",
    "kmReading",
    "dieselFilled",
    "openBowser",
    "closeBowser",
    "bowserLitersTaken",
    "variance"
  ];

  const allowedTextFields = [
    "entryDate",
    "siteName",
    "companyName",
    "bowserName",
    "notes",

    // Machine identity fields used by normal machine_fill entries.
    "machineId",
    "machineDocId",
    "firestoreMachineId",
    "selectedMachineId",
    "plantNumber",
    "machineType",
    "machineModel",
    "regNum",
    "registrationNumber"
  ];

  const update = {};

  for (const key of allowedTextFields) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      update[key] = norm(changes[key]);
    }
  }

  for (const key of numericFields) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      const value = Number(changes[key]);
      if (!Number.isFinite(value)) {
        throw new HttpsError("invalid-argument", `${key} must be a valid number.`);
      }
      update[key] = value;
    }
  }

  if (update.entryDate && !/^\d{4}-\d{2}-\d{2}$/.test(update.entryDate)) {
    throw new HttpsError("invalid-argument", "A valid entry date is required.");
  }

  if (
    Object.prototype.hasOwnProperty.call(update, "dieselFilled") &&
    update.dieselFilled <= 0
  ) {
    throw new HttpsError("invalid-argument", "Diesel filled must be more than 0.");
  }

  // Resolve the final values after applying the requested edit.
  const finalCompanyName = Object.prototype.hasOwnProperty.call(update, "companyName")
    ? update.companyName
    : norm(current.companyName);

  const finalPlantNumber = Object.prototype.hasOwnProperty.call(update, "plantNumber")
    ? update.plantNumber
    : norm(current.plantNumber);

  const finalRegNum =
    Object.prototype.hasOwnProperty.call(update, "regNum")
      ? update.regNum
      : Object.prototype.hasOwnProperty.call(update, "registrationNumber")
        ? update.registrationNumber
        : norm(current.regNum || current.registrationNumber || "");

  if (!finalCompanyName) {
    throw new HttpsError("invalid-argument", "Company is required.");
  }

  if (!finalPlantNumber) {
    throw new HttpsError("invalid-argument", "Plant Number is required.");
  }

  // Resolve the selected machine exactly as a normal saveDieselEntry does:
  // supplied Firestore machine ID first, then normalized plant number,
  // then plant/reg fields in Machine Master.
  const machineCollection = db.collection("dieselMachines");

  const candidateMachineIds = [
    update.machineId,
    update.machineDocId,
    update.firestoreMachineId,
    update.selectedMachineId,
    changes.machineId,
    changes.machineDocId,
    changes.firestoreMachineId,
    changes.selectedMachineId,
    normKey(finalPlantNumber),
  ].map(norm).filter(Boolean);

  let machineSnap = null;
  const checkedMachineIds = new Set();

  for (const candidateId of candidateMachineIds) {
    if (checkedMachineIds.has(candidateId)) continue;
    checkedMachineIds.add(candidateId);

    const candidateSnap = await machineCollection.doc(candidateId).get();
    if (candidateSnap.exists) {
      machineSnap = candidateSnap;
      break;
    }
  }

  if (!machineSnap) {
    const wantedPlant = normKey(finalPlantNumber);
    const wantedReg = normKey(finalRegNum);

    const allMachinesSnap = await machineCollection.get();

    machineSnap = allMachinesSnap.docs.find(docSnap => {
      const data = docSnap.data() || {};

      const plantMatches =
        wantedPlant &&
        normKey(
          data.plantNumber ||
          data.plantNo ||
          data.machineNumber ||
          ""
        ) === wantedPlant;

      const regMatches =
        wantedReg &&
        normKey(
          data.regNum ||
          data.registrationNumber ||
          data.registration ||
          ""
        ) === wantedReg;

      return plantMatches || regMatches;
    }) || null;
  }

  if (!machineSnap) {
    throw new HttpsError(
      "failed-precondition",
      "Machine was not found in Firestore Machine Master."
    );
  }

  const machine = machineSnap.data() || {};

  // Validate selected company against Machine Master.
  const allowedCompanies = extractAllowedCompanies(machine);
  const selectedCompanyKey = normalizeCompanyName(finalCompanyName);

  if (
    allowedCompanies.length &&
    !allowedCompanies.some(
      company => normalizeCompanyName(company) === selectedCompanyKey
    )
  ) {
    logger.warn("Admin machine fill edit company permission rejected", {
      entryId,
      machineId: machineSnap.id,
      plantNumber: finalPlantNumber,
      selectedCompany: finalCompanyName,
      allowedCompanies,
    });

    throw new HttpsError(
      "permission-denied",
      "Selected machine is not allowed for diesel use by the selected company."
    );
  }

  // The resolved Firestore Machine Master document is authoritative.
  update.machineId = machineSnap.id;

  // Keep the actual selected Machine Master identity together.
  update.plantNumber = norm(
    machine.plantNumber ||
    machine.plantNo ||
    machine.machineNumber ||
    finalPlantNumber
  );

  update.machineType = norm(
    machine.machineType ||
    machine.type ||
    update.machineType ||
    current.machineType ||
    ""
  );

  update.machineModel = norm(
    machine.machineModel ||
    machine.model ||
    update.machineModel ||
    current.machineModel ||
    ""
  );

  const resolvedRegNum = norm(
    machine.regNum ||
    machine.registrationNumber ||
    machine.registration ||
    finalRegNum
  );

  update.regNum = resolvedRegNum;

  if (
    Object.prototype.hasOwnProperty.call(current, "registrationNumber") ||
    Object.prototype.hasOwnProperty.call(changes, "registrationNumber")
  ) {
    update.registrationNumber = resolvedRegNum;
  }

  // Recalculate bowser-derived values if either reading changes.
  if (
    Object.prototype.hasOwnProperty.call(update, "openBowser") ||
    Object.prototype.hasOwnProperty.call(update, "closeBowser")
  ) {
    const open = Object.prototype.hasOwnProperty.call(update, "openBowser")
      ? update.openBowser
      : Number(current.openBowser || 0);

    const close = Object.prototype.hasOwnProperty.call(update, "closeBowser")
      ? update.closeBowser
      : Number(current.closeBowser || 0);

    update.bowserLitersTaken = Math.max(0, open - close);

    const filled = Object.prototype.hasOwnProperty.call(update, "dieselFilled")
      ? update.dieselFilled
      : Number(current.dieselFilled || 0);

    update.variance = update.bowserLitersTaken - filled;
  }

  update.sourceCompanyName = finalCompanyName;
  update.updatedAtText = saNowText();
  update.adminEdited = true;
  update.adminEditedBy = user.name || user.phone || user.uid || "Admin";
  update.adminEditedAt = FieldValue.serverTimestamp();
  update.sheetMirrorStatus = "pending";
  update.sheetMirrorError = "";

  await ref.set(update, { merge:true });

  const saved = (await ref.get()).data() || {};

  return {
    ok:true,
    entry:{ ...saved, id:entryId },
    rebuildRequired:true
  };
});

exports.adminDeleteDieselEntry = onCall({ region:"africa-south1", timeoutSeconds:120 }, async request => {
  const user = await getAllowedUserFromRequest(request);
  if (String(user.role || "user").toLowerCase() !== "admin") {
    throw new HttpsError("permission-denied", "Admin access is required.");
  }
  const entryId = norm(request.data?.entryId);
  if (!entryId) throw new HttpsError("invalid-argument", "Entry ID is required.");
  const ref = db.collection("dieselEntries").doc(entryId);
  const snap = await ref.get();
  if (!snap.exists) return { ok:true, deleted:false, rebuildRequired:false };
  await ref.delete();
  logger.info("Admin deleted Diesel entry from Firestore", { entryId, admin:user.phone || user.uid || "" });
  return { ok:true, deleted:true, rebuildRequired:true };
});

// ------------------------------------------------------------------
// Diesel -> Google Sheets server-side mirror
// ------------------------------------------------------------------
exports.mirrorDieselEntryToGoogleSheets = onDocumentWritten(
  { document:"dieselEntries/{entryId}", retry:true, timeoutSeconds:120, region:"africa-south1" },
  async event => {
    const afterSnap = event.data?.after;
    const beforeSnap = event.data?.before;
    const entryId = event.params.entryId;

    // Deleting in Firestore is authoritative. Mirror that deletion to Google Sheets.
    if (!afterSnap?.exists) {
      if (!beforeSnap?.exists) return;
      try {
        await postJson(DIESEL_SHEETS_URL, {
          action:"deleteEntryById",
          id:entryId,
          transactionType:norm(beforeSnap.data()?.transactionType || "machine_fill").toLowerCase(),
        });
        logger.info("Deleted Diesel entry mirrored to Google Sheets", { entryId });
      } catch (error) {
        logger.error("Could not mirror Diesel deletion to Google Sheets", { entryId, error:String(error.message || error) });
        throw error;
      }
      return;
    }

    const afterData = afterSnap.data() || {};
    const beforeData = beforeSnap?.exists ? (beforeSnap.data() || {}) : null;
    if (!businessDataChanged(beforeData, afterData)) return;

    const ref = db.collection("dieselEntries").doc(entryId);
    await ref.set({
      sheetMirrorStatus:"pending",
      sheetMirrorLastAttemptAt:FieldValue.serverTimestamp(),
      sheetMirrorAttempts:FieldValue.increment(1),
      sheetMirrorError:"",
    }, { merge:true });

    try {
      let result;
      if (beforeSnap?.exists) {
        result = await postJson(DIESEL_SHEETS_URL, {
          action:"updateEntry",
          entry:{ ...afterData, id:entryId },
        });
      } else {
        result = await postJson(DIESEL_SHEETS_URL, {
          action:"appendEntries",
          entries:[{ ...afterData, id:entryId }],
        });
      }
      await ref.set({
        sheetMirrorStatus:"success",
        sheetMirroredAt:FieldValue.serverTimestamp(),
        sheetMirrorError:FieldValue.delete(),
        sheetMirrorLastResult:{ serverStamp:Number(result.serverStamp || 0) || 0 },
      }, { merge:true });
      logger.info("Diesel entry mirrored to Google Sheets", { entryId });
    } catch (error) {
      await ref.set({
        sheetMirrorStatus:"error",
        sheetMirrorError:String(error.message || error).slice(0,1000),
      }, { merge:true });
      throw error;
    }
  }
);
