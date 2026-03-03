with open('/Users/icl-agent/icl-twilio-intake/conversation.js', 'r') as f:
    code = f.read()

# Fix 1: main lead fetch at top of handleConversation - make handleConversation fully async from start
# Line 52: const lead = getLead.get(from_phone);
code = code.replace(
    '  const lead = getLead.get(from_phone);\n  const state = getConvState(lead);',
    '  const lead = await getLead.get(from_phone);\n  const state = getConvState(lead);'
)

# Fix 2: line 98 - second getLead call in advanceAfterAddress
code = code.replace(
    'async function advanceAfterAddress(from_phone) {\n  const lead = getLead.get(from_phone);',
    'async function advanceAfterAddress(from_phone) {\n  const lead = await getLead.get(from_phone);'
)

# Fix 3: line 161 - afterAccess check
code = code.replace(
    '      const afterAccess=getLead.get(from_phone);',
    '      const afterAccess=await getLead.get(from_phone);'
)

with open('/Users/icl-agent/icl-twilio-intake/conversation.js', 'w') as f:
    f.write(code)

print("Done")
