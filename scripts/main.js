"use strict";
const year = document.querySelector("#year");
if (year) year.textContent = new Date().getFullYear();

const menuToggle = document.querySelector(".menu-toggle");
if (menuToggle) {
  const menu = document.getElementById(menuToggle.getAttribute("aria-controls"));

  const closeMenu = () => {
    menuToggle.setAttribute("aria-expanded", "false");
    menu?.removeAttribute("data-menu-open");
  };

  menuToggle.addEventListener("click", () => {
    const isOpen = menuToggle.getAttribute("aria-expanded") === "true";
    menuToggle.setAttribute("aria-expanded", String(!isOpen));
    if (isOpen) menu?.removeAttribute("data-menu-open");
    else menu?.setAttribute("data-menu-open", "true");
  });

  menu?.addEventListener("click", (event) => {
    if (event.target.closest("a")) closeMenu();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      closeMenu();
      menuToggle.focus();
    }
  });

  window.addEventListener("resize", () => {
    if (window.innerWidth > 760) closeMenu();
  });
}

const songButtons = document.querySelectorAll("[data-track-id]");
songButtons.forEach((button) => {
  button.addEventListener("click", () => {
    const trackId = button.dataset.trackId;
    const trackTitle = button.dataset.trackTitle || "Joshua Jacob";
    const playerPath = window.location.pathname.includes("/pages/") ? "player.html" : "pages/player.html";
    const playerUrl = new URL(playerPath, window.location.href);
    playerUrl.searchParams.set("track", trackId);
    playerUrl.searchParams.set("title", trackTitle);

    const playerWindow = window.open(
      playerUrl.toString(),
      "joshBeyondBordersPlayer",
      "popup=yes,width=430,height=610,resizable=yes"
    );
    playerWindow?.focus();
  });
});
