"use strict";

const loginPanel = document.querySelector("#login-panel");
const resourcesPanel = document.querySelector("#resources-panel");
const loginForm = document.querySelector("#admin-login-form");
const loginStatus = document.querySelector("#login-status");
const adminId = document.querySelector("#admin-id");
const adminPassword = document.querySelector("#admin-password");
const signoutButton = document.querySelector("#admin-signout");
const sessionKey = "jbb-admin-authenticated";

const showResources = () => {
  loginPanel.hidden = true;
  resourcesPanel.hidden = false;
  signoutButton.focus();
};

const showLogin = () => {
  resourcesPanel.hidden = true;
  loginPanel.hidden = false;
  loginForm.reset();
  loginStatus.textContent = "";
  adminId.focus();
};

const sha256 = async (value) => {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0")
  ).join("");
};

const safeEqual = (left, right) => {
  if (left.length !== right.length) return false;
  let mismatch = 0;
  for (let index = 0; index < left.length; index += 1) {
    mismatch |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return mismatch === 0;
};

const authConfig = fetch("auth.json", { cache: "no-store" }).then((response) => {
  if (!response.ok) throw new Error("Unable to load the login configuration.");
  return response.json();
});

if (sessionStorage.getItem(sessionKey) === "true") {
  showResources();
} else {
  adminId.focus();
}

loginForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  loginStatus.textContent = "Checking credentials...";

  try {
    const config = await authConfig;
    const submittedHash = await sha256(`${config.salt}:${adminPassword.value}`);
    const idMatches = safeEqual(adminId.value, config.id);
    const passwordMatches = safeEqual(submittedHash, config.passwordHash);

    if (!idMatches || !passwordMatches) {
      loginStatus.textContent = "The ID or password is incorrect.";
      adminPassword.value = "";
      adminPassword.focus();
      return;
    }

    sessionStorage.setItem(sessionKey, "true");
    loginStatus.textContent = "";
    showResources();
  } catch (error) {
    loginStatus.textContent = "The Admin Portal could not be opened. Please try again later.";
  }
});

signoutButton.addEventListener("click", () => {
  sessionStorage.removeItem(sessionKey);
  showLogin();
});
