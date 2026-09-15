import { test } from "node:test";
import assert from "node:assert/strict";
import { canAccessInventory, inventoryAccessGuard } from "../src/inventoryAccess.js";

test("demo inventory is available only to ADMIN and the exact USER fares account", () => {
  for (const user of [
    { role: "ADMIN", username: "admin" },
    { role: "ADMIN", username: "another-admin" },
    { role: "USER", username: "fares" },
  ]) assert.equal(canAccessInventory(user), true);
  for (const user of [
    undefined, {},
    { role: "USER", username: "another-user" },
    { role: "USER", username: "FARES" },
    { role: "USER", username: "fares.demo" },
    { role: "SUPERVISOR", username: "fares" },
    { role: "SUPERVISOR", username: "supervisor" },
    { username: "fares" },
  ]) assert.equal(canAccessInventory(user), false);
});

test("demo guard denies all writes by fares and all requests by excluded accounts", () => {
  for (const role of ["ADMIN", "USER", "SUPERVISOR"]) {
    for (const username of ["fares", "another-user"]) {
      for (const method of ["GET", "HEAD", "OPTIONS", "POST", "PATCH", "PUT", "DELETE"]) {
        let calls = 0, result;
        inventoryAccessGuard({ user: { role, username }, method }, {}, error => {
          calls++;
          result = error;
        });
        const allowed = role === "ADMIN" || (role === "USER" && username === "fares" && ["GET", "HEAD", "OPTIONS"].includes(method));
        assert.equal(calls, 1);
        assert.equal(result?.statusCode, allowed ? undefined : 403, `${role} ${username} ${method}`);
      }
    }
  }
});
