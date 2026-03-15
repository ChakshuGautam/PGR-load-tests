import { sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';
import exec from 'k6/execution';
import { login, makeRequestInfo } from '../helpers/auth.js';
import { createComplaint, updateComplaint, searchComplaint, isAuthError } from '../helpers/pgr.js';
import { getEnv } from '../config/environments.js';

// Custom metrics
export const transactionDuration = new Trend('transaction_duration', true);
export const transactionSuccess = new Rate('transaction_success');

// Module-scope token cache (per VU)
let employeeToken = null;
let employeeUserInfo = null;
let employeeUUID = null;

const SERVICE_CODE = 'StreetLightNotWorking';

function thinkTime() {
  sleep(Math.random() * 2 + 1);
}

function ensureEmployeeAuth(env) {
  if (!employeeToken) {
    const auth = login(env.baseUrl, env.username, env.password, env.tenant, 'EMPLOYEE');
    if (!auth) return false;
    employeeToken = auth.token;
    employeeUserInfo = auth.userInfo;
    employeeUUID = auth.userInfo.uuid;
  }
  return true;
}

/**
 * Run one full PGR complaint lifecycle.
 * Called by scenario files (ramp-2vu, ramp-10vu, ramp-50vu).
 */
export function pgrLifecycle() {
  const env = getEnv();
  const start = Date.now();
  let success = false;

  try {
    // Step 1: Ensure employee auth
    if (!ensureEmployeeAuth(env)) return;
    thinkTime();

    // Citizen identity for this VU
    const vuId = exec.vu.idInTest;
    const citizenIndex = (vuId % 100) + 1;
    const citizenPhone = `9900000${String(citizenIndex).padStart(3, '0')}`;
    const citizenName = `LoadTestCitizen_${citizenIndex}`;

    // Step 2: Create complaint (with 401 retry)
    let service = createComplaint(
      env.baseUrl, employeeToken, employeeUserInfo,
      env.tenant, SERVICE_CODE, citizenPhone, citizenName
    );
    if (!service) {
      // Could be 401 — clear auth and retry once
      clearEmployeeAuth();
      if (!ensureEmployeeAuth(env)) return;
      service = createComplaint(
        env.baseUrl, employeeToken, employeeUserInfo,
        env.tenant, SERVICE_CODE, citizenPhone, citizenName
      );
      if (!service) return;
    }
    thinkTime();

    // Step 3: Assign to self (employee as LME)
    const assigned = updateComplaint(
      env.baseUrl, employeeToken, employeeUserInfo,
      service, 'ASSIGN', [employeeUUID], 'Load test assignment'
    );
    if (!assigned) return;
    thinkTime();

    // Step 4: Resolve
    const resolved = updateComplaint(
      env.baseUrl, employeeToken, employeeUserInfo,
      assigned, 'RESOLVE', [employeeUUID], 'Load test resolution'
    );
    if (!resolved) return;
    thinkTime();

    // Step 5: Rate & Close (as citizen)
    // Login as citizen for RATE action (citizens pre-created by Ansible setup)
    const citizenAuth = login(env.baseUrl, citizenPhone, 'eGov@123', env.tenant, 'CITIZEN');
    if (!citizenAuth) {
      console.error(`Citizen login failed for ${citizenPhone}, skipping RATE`);
      return;
    }
    const rated = updateComplaint(
      env.baseUrl, citizenAuth.token, citizenAuth.userInfo,
      resolved, 'RATE', [], 'Load test rating - 5 stars', 5
    );
    if (!rated) return;
    thinkTime();

    // Step 6: Verify via search
    const found = searchComplaint(
      env.baseUrl, employeeToken, employeeUserInfo,
      env.tenant, service.serviceRequestId
    );
    if (!found) return;

    if (found.applicationStatus === 'CLOSEDAFTERRESOLUTION') {
      success = true;
    } else {
      console.warn(`Unexpected final status: ${found.applicationStatus}`);
    }
  } finally {
    const duration = Date.now() - start;
    transactionDuration.add(duration);
    transactionSuccess.add(success ? 1 : 0);
  }
}

/**
 * Clear cached employee token so next iteration re-authenticates.
 * Called internally when a 401 is detected.
 */
function clearEmployeeAuth() {
  employeeToken = null;
  employeeUserInfo = null;
  employeeUUID = null;
}
