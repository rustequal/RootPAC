const OWN_CONTROL = new Set(["controllable_by_this_extension", "controlled_by_this_extension"]);
const CONTROLLED = "controlled_by_this_extension";
const WEBRTC_POLICY = "disable_non_proxied_udp";

export function createProxy({ proxy, privacy, extension }) {
  const settings = {
    proxy: proxy.settings,
    prediction: privacy.network.networkPredictionEnabled,
    webrtc: privacy.network.webRTCIPHandlingPolicy,
  };
  // The settings are read at once: a check follows every commit and every change of any of them.
  const read = async (incognito) => {
    const names = Object.keys(settings);
    const values = await Promise.all(names.map((name) => settings[name].get({ incognito })));
    return Object.fromEntries(names.map((name, index) => [name, values[index]]));
  };
  const levelsOf = (current) => Object.fromEntries(Object.entries(current).map(([name, { levelOfControl }]) => [name, levelOfControl]));
  const holds = (current, data) => {
    const pac = current.proxy.value?.mode === "pac_script" ? current.proxy.value.pacScript : undefined;
    return (
      Object.values(current).every(({ levelOfControl }) => levelOfControl === CONTROLLED) &&
      pac?.data === data &&
      pac.mandatory === true &&
      current.prediction.value === false &&
      current.webrtc.value === WEBRTC_POLICY
    );
  };
  const control = async (data = null) => {
    const [regular, incognito] = await Promise.all([read(false), extension.isAllowedIncognitoAccess()]);
    const profiles = incognito ? [regular, await read(true)] : [regular];
    const [levels, incognitoLevels = null] = profiles.map(levelsOf);
    return {
      levels,
      incognitoLevels,
      controllable: profiles.every((current) => Object.values(current).every(({ levelOfControl }) => OWN_CONTROL.has(levelOfControl))),
      armed: data !== null && profiles.every((current) => holds(current, data)),
    };
  };
  return {
    control,
    async apply(data) {
      await settings.prediction.set({ scope: "regular", value: false });
      await settings.webrtc.set({ scope: "regular", value: WEBRTC_POLICY });
      await settings.proxy.set({
        scope: "regular",
        value: { mode: "pac_script", pacScript: { data, mandatory: true } },
      });
      return control(data);
    },
    async clear() {
      for (const setting of Object.values(settings)) await setting.clear({ scope: "regular" });
      return control();
    },
  };
}
