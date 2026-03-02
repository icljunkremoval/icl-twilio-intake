module.exports = {
  apps: [
    {
      name: "icl-twilio-intake",
      script: "/Users/icl-agent/icl-twilio-intake/server.js",
      env: {
        NODE_ENV: "production",
        TWILIO_ACCOUNT_SID: "AC4121806732f35a7b48ce333e151cc6cc",
        TWILIO_AUTH_TOKEN: "8266d2142f0bf385dfd90fbae908e9b8",
        TWILIO_FROM_NUMBER: "+18555785014",
        SQUARE_ACCESS_TOKEN: "EAAAl25ORWwhgIdZqdUKBW8NXOAg1jL1_Z2P3NWghjDjF_7Ph1T6BBGtZPwpalHF",
        SQUARE_LOCATION_ID: "LEK5GXJFY8754",
        ANTHROPIC_API_KEY: "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"
      }
    },
    {
      name: "icl-watchdog",
      script: "/Users/icl-agent/icl-twilio-intake/watchdog.js",
      env: {
        NODE_ENV: "production",
        TWILIO_ACCOUNT_SID: "AC4121806732f35a7b48ce333e151cc6cc",
        TWILIO_AUTH_TOKEN: "8266d2142f0bf385dfd90fbae908e9b8",
        TWILIO_FROM_NUMBER: "+18555785014",
        WATCHDOG_ALERT_PHONE: "+13233979698"
      }
    }
  ]
};
