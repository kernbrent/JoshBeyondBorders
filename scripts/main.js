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

const partnersGrid = document.querySelector(".partners-page");
if (partnersGrid) {
  const partnerCards = Array.from(partnersGrid.querySelectorAll(".partner-card"));

  if (partnerCards.length > 1) {
    const previousOrder = sessionStorage.getItem("partner-order");
    let shuffledCards;
    let shuffledOrder;

    do {
      shuffledCards = [...partnerCards];
      for (let index = shuffledCards.length - 1; index > 0; index -= 1) {
        const randomIndex = Math.floor(Math.random() * (index + 1));
        [shuffledCards[index], shuffledCards[randomIndex]] = [
          shuffledCards[randomIndex],
          shuffledCards[index],
        ];
      }

      shuffledOrder = shuffledCards
        .map((card) => card.querySelector("h2")?.textContent.trim())
        .join("|");
    } while (shuffledOrder === previousOrder);

    shuffledCards.forEach((card) => partnersGrid.appendChild(card));
    sessionStorage.setItem("partner-order", shuffledOrder);
  }
}
const spotifyEmbeds = document.querySelectorAll("[data-spotify-uri]");
if (spotifyEmbeds.length || songButtons.length) {
  window.onSpotifyIframeApiReady = (IFrameAPI) => {
    const spotifyPlayers = [];

    const updatePlayerVisual = (player, isActive) => {
      player.tile?.toggleAttribute("data-playing", isActive);
      player.button?.toggleAttribute("data-playing", isActive);
      player.button?.setAttribute("aria-pressed", String(isActive));
    };

    const setActivePlayer = (activePlayer, pauseOthers = false) => {
      spotifyPlayers.forEach((player) => {
        const isActive = player === activePlayer;
        updatePlayerVisual(player, isActive);
        if (!isActive && pauseOthers) player.controller.pause();
      });
    };

    const watchPlayback = (player) => {
      player.controller.addListener("playback_started", () => {
        player.hasStarted = true;
        setActivePlayer(player, true);
      });

      player.controller.addListener("playback_update", (event) => {
        if (event.data.isPaused) {
          updatePlayerVisual(player, false);
        } else {
          setActivePlayer(player);
        }
      });
    };

    spotifyEmbeds.forEach((element) => {
      const options = {
        width: "100%",
        height: "100%",
        uri: element.dataset.spotifyUri,
      };

      IFrameAPI.createController(element, options, (controller) => {
        const player = {
          controller,
          tile: element.closest(".spotify-embed"),
        };
        spotifyPlayers.push(player);
        watchPlayback(player);
      });
    });

    songButtons.forEach((button) => {
      const audioHolder = document.createElement("span");
      const controllerMount = document.createElement("span");
      audioHolder.className = "inline-spotify-audio";
      audioHolder.setAttribute("aria-hidden", "true");
      audioHolder.appendChild(controllerMount);
      document.body.appendChild(audioHolder);
      button.setAttribute("aria-pressed", "false");

      const options = {
        width: "300",
        height: "80",
        uri: "spotify:track:" + button.dataset.trackId,
      };

      IFrameAPI.createController(controllerMount, options, (controller) => {
        const player = { controller, button, hasStarted: false };
        spotifyPlayers.push(player);
        watchPlayback(player);

        button.addEventListener("click", () => {
          if (button.hasAttribute("data-playing")) {
            controller.pause();
          } else {
            spotifyPlayers.forEach((otherPlayer) => {
              if (otherPlayer !== player) {
                updatePlayerVisual(otherPlayer, false);
                otherPlayer.controller.pause();
              }
            });

            if (player.hasStarted) controller.resume();
            else controller.play();
          }
        });
      });
    });
  };
}
const siteFooter = document.querySelector(".site-footer");
if (siteFooter && !siteFooter.querySelector(".developer-credit")) {
  const credit = document.createElement("a");
  credit.className = "developer-credit";
  credit.href = "https://careersteps.net/";
  credit.setAttribute("aria-label", "Visit Career Steps Consulting LLC");
  credit.innerHTML = `
    <img src="/assets/career-steps-logo.png" alt="" width="28" height="28">
    <span>Website developed and maintained by <strong>Career Steps Consulting LLC.</strong></span>
  `;
  siteFooter.appendChild(credit);
}
