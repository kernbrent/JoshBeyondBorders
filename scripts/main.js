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
    let activePlayer = null;

    const updateSelectionVisual = (player, isSelected) => {
      player.tile?.toggleAttribute("data-active", isSelected);
    };

    const updatePlaybackVisual = (player, isPlaying) => {
      player.isPlaying = isPlaying;
      player.tile?.toggleAttribute("data-playing", isPlaying);
      player.button?.toggleAttribute("data-playing", isPlaying);
      player.button?.setAttribute("aria-pressed", String(isPlaying));
    };

    const pausePlayer = (player) => {
      const pauseRequest = ++player.pauseRequest;
      player.resumeRequest += 1;
      player.pausePending = true;
      updatePlaybackVisual(player, false);
      player.controller.pause();

      window.setTimeout(() => {
        if (player.pauseRequest === pauseRequest) player.pausePending = false;
      }, 1000);
    };

    const selectPlayer = (nextPlayer) => {
      const previousPlayer = activePlayer;
      activePlayer = nextPlayer;
      nextPlayer.pauseRequest += 1;
      nextPlayer.pausePending = false;

      spotifyPlayers.forEach((player) => {
        const isSelected = player === nextPlayer;
        updateSelectionVisual(player, isSelected);

        if (
          !isSelected &&
          (player === previousPlayer || player.isPlaying || player.pausePending)
        ) {
          pausePlayer(player);
        }
      });
    };

    const handlePlayingSignal = (player) => {
      if (player.pausePending) {
        player.controller.pause();
        return;
      }

      player.pausePending = false;
      if (player !== activePlayer) selectPlayer(player);
      updatePlaybackVisual(player, true);
    };

    const watchPlayback = (player) => {
      player.controller.addListener("playback_started", () => {
        player.hasStarted = true;
        handlePlayingSignal(player);
      });

      player.controller.addListener("playback_update", (event) => {
        if (typeof event.data?.isPaused !== "boolean") return;

        if (event.data.isPaused) {
          player.pausePending = false;
          updatePlaybackVisual(player, false);
          return;
        }

        handlePlayingSignal(player);
      });
    };

    const selectFocusedEmbed = (focusedElement) => {
      if (!(focusedElement instanceof HTMLIFrameElement)) return;

      const focusedPlayer = spotifyPlayers.find((player) =>
        player.tile?.contains(focusedElement)
      );
      if (!focusedPlayer) return;

      const isSwitchingPlayers = focusedPlayer !== activePlayer;
      selectPlayer(focusedPlayer);
      if (isSwitchingPlayers && focusedPlayer.hasStarted) {
        const resumeRequest = ++focusedPlayer.resumeRequest;
        window.setTimeout(() => {
          if (
            focusedPlayer.resumeRequest === resumeRequest &&
            focusedPlayer === activePlayer &&
            !focusedPlayer.isPlaying &&
            !focusedPlayer.pausePending
          ) {
            focusedPlayer.controller.resume();
          }
        }, 250);
      }
    };

    document.addEventListener(
      "focus",
      (event) => selectFocusedEmbed(event.target),
      true
    );
    window.addEventListener("blur", () => {
      window.setTimeout(() => selectFocusedEmbed(document.activeElement), 0);
    });
    let lastFocusedEmbed = null;
    window.setInterval(() => {
      const focusedElement = document.activeElement;
      const focusedTile =
        focusedElement instanceof HTMLIFrameElement
          ? focusedElement.closest(".spotify-embed")
          : null;

      if (focusedTile && focusedElement !== lastFocusedEmbed) {
        selectFocusedEmbed(focusedElement);
        lastFocusedEmbed = focusedElement;
      } else if (!focusedTile) {
        lastFocusedEmbed = null;
      }
    }, 100);

    spotifyEmbeds.forEach((element) => {
      const tile = element.closest(".spotify-embed");
      const options = {
        width: "100%",
        height: "100%",
        uri: element.dataset.spotifyUri,
      };

      IFrameAPI.createController(element, options, (controller) => {
        const player = {
          controller,
          tile,
          isPlaying: false,
          hasStarted: false,
          pausePending: false,
          pauseRequest: 0,
          resumeRequest: 0,
        };
        spotifyPlayers.push(player);
        updateSelectionVisual(player, false);
        updatePlaybackVisual(player, false);
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
        const player = {
          controller,
          button,
          isPlaying: false,
          hasStarted: false,
          pausePending: false,
          pauseRequest: 0,
          resumeRequest: 0,
        };
        spotifyPlayers.push(player);
        updatePlaybackVisual(player, false);
        watchPlayback(player);

        button.addEventListener("click", () => {
          if (player === activePlayer && player.isPlaying) {
            pausePlayer(player);
          } else {
            player.pausePending = false;
            selectPlayer(player);
            updatePlaybackVisual(player, true);
            controller.resume();
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
