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