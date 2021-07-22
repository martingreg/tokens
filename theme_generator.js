const fs = require('fs');
const parseColour = require('color-parse');
const merge = require('lodash.merge');
const args = require('args-parser')(process.argv);
const camelCase = require('camelcase');
const path = require('path');

function useColourNames(tokens, path) {
  Object.entries(tokens).forEach(([key, value]) => {
    const colourName = (path) ? (path + '-' + key) : key;
    if (typeof value === 'object') {
      useColourNames(value, colourName);
    } else if (typeof value === 'string') {
      tokens[key] = colourName;
    } else {
      console.error('Unexpected type of colour ' + typeof value);
      process.exit(1);
    }
  });
}

/* Takes a hierarchy and converts a { b { c:d } } to a-b-c: d
 * This also drags UI states (those starting with #) to the end of the token names
 */
function flattenObject(objectPath, childObject, flattenedTokens, uiState) {
  Object.entries(childObject).forEach(([key, value]) => {
    if (key.includes('-')) {
      console.error('Found an illegal hyphen in key ' + key + ' at ' + objectPath);
      process.exit(1);
    }
    if ((key.startsWith('#')) && (typeof value === 'object')) {
      if (uiState) {
        console.error('Picked up uiState ' + key + ' at ' + objectPath + ' while already carrying ' + uiState);
        process.exit(1);
      } else {
        flattenObject(objectPath, value, flattenedTokens, key);
      }
    } else {  
      const childPath = (objectPath) ? objectPath+'-'+key : key;
      if (typeof value === 'object') {
        flattenObject(childPath, value, flattenedTokens);
      } else {
        flattenedTokens[(uiState) ? (childPath+'-'+uiState) : childPath] = value;
      }
    }
  });
}

function unflattenObject(flattenedTokens) {
  const output = {};
  Object.entries(flattenedTokens).forEach(([key, value]) => {
    const tokenParts = key.split('-');
    let currentObject = output;
    while (tokenParts.length > 1) {
      if (!(tokenParts[0] in currentObject)) {
        currentObject[tokenParts[0]] = {};
      }
      currentObject = currentObject[tokenParts.shift()];
    }
    currentObject[tokenParts[0]] = value;
  });
  return output;
}

// Loads a JSON file or directory of files and returns an object with the contents of all the files merged together
function loadFile(fileName, isDirectory) {
  if (isDirectory) {
    console.log('Loading directory ' + fileName);
    const fileList = fs.readdirSync(fileName, {withFileTypes: true});
    const tokenData = {};
    fileList.forEach((childFile) => {
      merge(tokenData, loadFile(fileName+"/"+childFile.name, childFile.isDirectory()));
    });
    return tokenData;
  }
  else if (fileName.endsWith('.json')) {
    console.log('Loading file ' + fileName);
    const tokenFileData = fs.readFileSync(fileName);
    /* We don't return the JSON directly - instead we fiddle with the structure of the files to ensure that UI states are always the last part of a token name
     * by flattening it, reordering the keys, and then unflattening it
     */
    const parsedTokenFile = JSON.parse(tokenFileData);
    const flattenedTokenFile = {};
    flattenObject('', parsedTokenFile, flattenedTokenFile);
    return unflattenObject(flattenedTokenFile);
  }
  else {
    console.log('Unknown type of file ' + fileName);
    return {};
  }
}

// Finds a flattened key in the non-flattened hierarchy
function findKey(keyParts, tokens) {
  if (!keyParts[0] in tokens) {
    return null;
  } else if (keyParts.length === 1) {
    return tokens[keyParts[0]];
  } else if (typeof tokens[keyParts[0]] === 'object') {
    return findKey(keyParts.slice(1), tokens[keyParts[0]]);
  } else {
    return null;
  }
}

// Parses a value and normalises the unit if required
function normaliseUnit(value) {
  //console.log('Normalising unit type ' + typeof value + ' value ' + value);
  if ((typeof value === 'string') && (value.startsWith('#') || value.startsWith('rgb'))) {
    const c = parseColour(value);
    if (!c) {
      console.log('Unable to parse colour: ' + value);
      process.exit(1);
    }
    if (colorFormat === 'rgba') {
      return `rgba(${c.values[0]}, ${c.values[1]}, ${c.values[2]}, ${c.alpha})`;
    } else if (colorFormat === 'object') {
      return { r: c.values[0], g: c.values[1], b: c.values[2], a: c.alpha };
    } else if (colorFormat === 'hex') {
      r = c.values[0].toString(16).padStart(2,'0');
      g = c.values[1].toString(16).padStart(2,'0');
      b = c.values[2].toString(16).padStart(2,'0');
      a = (c.alpha === 1) ? '' : Math.round(c.alpha * 255).toString(16).padStart(2,'0');
      return "#" + r + g + b + a;
    }
  } else if ((typeof value === 'string') && (value.endsWith('px'))) {
    const pxSize = parseInt(value.slice(0,-2));
    if (isNaN(pxSize)) {
      console.log('Unable to parse size: ' + value);
      process.exit(1);
    }
    if (sizeUnit === 'px') {
      return pxSize + 'px';
    } else if (sizeUnit === 'pt') {
      return (pxSize * 0.75) + 'pt';
    } else if (sizeUnit === 'rem') {
      return (pxSize/16) + 'rem';
    }
  }
  return value;
}

// Finds references, and returns an object with all references resolved
// You can probably break this with recursive references, can't be bothered to check
function resolveValue(currentToken, allTokens, coreTokens, flattenedCoreTokens) {
  if (typeof currentToken === 'object') { // If this is an object, return a version with all children resolved
    Object.entries(currentToken).forEach(([key, value]) => {
      currentToken[key] = resolveValue(value, allTokens, coreTokens, flattenedCoreTokens);
    });
    return currentToken;
  } else if ((typeof currentToken === 'string') && (currentToken.startsWith('@'))) { // If it's a reference, return the resolved object
    const tokenName = currentToken.slice(1);
    if (tokenName in flattenedCoreTokens) { // easy case - it refers to something in the core
      return flattenedCoreTokens[tokenName];
    } else { // Otherwise we've got to find the token
      const keyParts = tokenName.split('-');
      let value = findKey(keyParts, allTokens); // First of all try to find it as a reference to another token which actually exists
      if (!value) { // Maybe it's a reference to a complete core token group, in which case we should substitute in the whole group
        value = findKey(keyParts, coreTokens);
      }
      if (!value) { // If we can't find it, it might be going indirectly through a reference to another group
        for (i=1; i<keyParts.length; i++) {
          const groupParts = keyParts.slice(0, -i);
          const groupValue = findKey(groupParts, allTokens);
          if (groupValue) {
            if (groupValue[0] != '@') {
              console.error(currentToken + ' could not be found. Tried resolving via ' + groupParts.join('-') + ' but that was not a reference');
              process.exit(1);
            }
            const substituteParts = groupValue.slice(1).split('-').concat(keyParts.slice(-i));
            const substituteName = substituteParts.join('-');
            if (substituteName in flattenedCoreTokens) {
              return flattenedCoreTokens[substituteName];
            }
            value = findKey(substituteParts, allTokens);
            break;
          }
        }
      }
      if (!value) { // If we still can't find it, it's probably broken
        console.log('Unable to find ' + currentToken + ' in ' + JSON.stringify(allTokens, null, 2));
        process.exit(1);
      }
      return resolveValue(value, allTokens, coreTokens, flattenedCoreTokens);
    }
  } else { // Otherwise, we don't need to do any resolution
    return currentToken;
  }
}

// Sorts out UI states, and resolves units to the requested
function finaliseTokens(tokens) {
  const finalisedTokens = {};
  Object.entries(tokens).forEach(([key, value]) => {
    const keyParts = key.split('-');
    const validUiStates = ['normal', 'hovered', 'pressed', 'disabled', 'focused', 'active', 'checked'];
    let uiState = validUiStates[0];
    if (keyParts[keyParts.length-1].startsWith('#')) 
    {
      //This is a state, so sanity check it falls into allowed values
      uiState = keyParts.pop().slice(1);
      if (!validUiStates.includes(uiState)) {
        console.log(`Unknown ui state: ${uiState} when resolving ${key}`);
        process.exit(1);
      }
    }
    const baseKeyName = keyParts.join('-');
    if (uiStatesAsObject) {
      if (!(baseKeyName in finalisedTokens)) {
        finalisedTokens[baseKeyName] = {};
      }
      finalisedTokens[baseKeyName][uiState] = normaliseUnit(value);
    }
    else {
      if (uiState === validUiStates[0]) {
        finalisedTokens[baseKeyName] = normaliseUnit(value);
      } else {
        finalisedTokens[baseKeyName+'-'+uiState] = normaliseUnit(value);
      }
    }
  });
  return finalisedTokens;
}

let platform='web';
if (args.platform) {
  platform = args.platform;
  delete args.platform;
}

let colorFormat='rgba';
let sizeUnit='px';
let componentGroups=false;
let fileFormat='json';
let includeMobileTokens=false;
let includeDesktopTokens=false;
let uiStatesAsObject=true;
let omitThemeTokens=false;

console.log('Setting up for platform: ' + platform);
if (platform === 'web') {
  colorFormat = 'rgba';
  sizeUnit='rem';
  fileFormat='css';
} else if (platform === 'qt') {
  colorFormat = 'object';
  sizeUnit='px';
  includeDesktopTokens = true;
} else if (platform === 'macos') {
  colorFormat = 'object';
  sizeUnit='px';
  includeDesktopTokens = true;
} else if (platform === 'android') {
  colorFormat = 'names';
  includeMobileTokens = true;
  uiStatesAsObject = false;
  omitThemeTokens = true;
} else if (platform === 'ios') {
  colorFormat = 'names';
  sizeUnit='pt';
  componentGroups = true;
  includeMobileTokens = true;
  uiStatesAsObject = false;
  omitThemeTokens = true;
} else {
  console.log('Unknown platform: ' + platform);
  process.exit(1);
}

if (args.colorFormat) {
  if (args.colorFormat === 'hex') {
    colorFormat = 'hex';
  } else if (args.colorFormat === 'rgba') {
    colorFormat = 'rgba';
  } else if (args.colorFormat === 'object') {
    colorFormat = 'object';
  } else if (args.colorFormat === 'names') {
    colorFormat = 'names';
  } else {
    console.log('Unknown color format: ' + args.colorFormat);
    process.exit(1);
  }
  delete args.colorFormat;
}

if (args.sizeUnit) {
  if (args.sizeUnit === 'px') {
    sizeUnit = 'px';
  } else if (args.sizeUnit === 'pt') {
    sizeUnit = 'pt';
  } else if (args.sizeUnit === 'rem') {
    sizeUnit = 'rem';
  } else {
    console.log('Unknown size unit: ' + args.sizeUnit);
    process.exit(1);
  }
  delete args.sizeUnit;
}

if (args.componentGroups) {
  componentGroups = true;
  delete args.componentGroups;
}

if (args.omitThemeTokens) {
  omitThemeTokens = args.omitThemeTokens;
  delete args.omitThemeTokens;
}

if (args.fileFormat) {
  if (args.fileFormat === 'css') {
    fileFormat = 'css';
  } else if (args.fileFormat === 'json') {
    fileFormat = 'json';
  } else {
    console.log('Unknown file format: ' + args.fileFormat);
    process.exit(1);
  }
  delete args.fileFormat;
}

if (fileFormat === 'css') {
  uiStatesAsObject = false; // Can't have objects in CSS
}

console.log('Using colorFormat ' + colorFormat);
console.log('Using sizeUnit ' + sizeUnit);
console.log('Using componentGroups ' + componentGroups);
console.log('Using fileFormat ' + fileFormat);

let toStdOut=false;
if (args.toStdOut) {
  toStdOut = args.toStdOut;
  delete args.toStdOut;
}

if (Object.keys(args).length === 0) {
  console.log(`Usage: ${process.argv[1]} [OPTION]... [THEME FILE]...`);
  console.log('Options');
  console.log('  --colorFormat=[hex|rgba]    What color format to use in the output.');
  console.log('       rgba   -> rgba(244,233,20,0.8)');
  console.log('       object -> { "r": 244, "g": 233, "b": 20, "a": 0.8 }');
  console.log('       hex    -> #RRGGBBAA');
  console.log('       names  -> red-05');
  console.log('  --sizeUnit=[px|pt|rem]      What unit to use for sizes in the output.');
  console.log('       px    -> pixels (matching that on Figma)');
  console.log('       pt    -> points (pixels * 0.75)');
  console.log('       rem   -> root em, used on web to create sizes relative to user font size');
  console.log('  --componentGroups           Group tokens by component');
  console.log('  --omitThemeTokens           Removes theme tokens from the generated file');
  console.log('  --fileFormat=[css|json]     What format to use for the output files');
  console.log('  --platform=PLATFORM         Which platform to generate for.');
  console.log('       web');
  console.log('       qt');
  console.log('       macos');
  console.log('       ios');
  console.log('       android');
  console.log('  --toStdOut                  Output to std out instead of writing to files');
  process.exit(1);
}

// Start by loading all the token files
console.log('=== Loading core files ===================');
let coreTokens = loadFile("core", true);
if (colorFormat === 'names') {
  useColourNames(coreTokens['color']);
}
// Then flatten all the tokens
const flattenedCoreTokens = {};
flattenObject('', coreTokens, flattenedCoreTokens);
console.log('=== Core files loaded ====================');

const indexFileData = [];

Object.keys(args).forEach(themeFileName => {
  console.log('=== Processing theme =====================');
  
  // Load all the files to build one big object
  let themeFileData = fs.readFileSync(themeFileName);
  let themeFile = JSON.parse(themeFileData);
  console.log(`Loading theme ${themeFile.name} for platform ${platform} using color format ${colorFormat}`);
  let tokenData = loadFile('components', true);
  try {
    merge(tokenData, loadFile('platformcomponents/'+platform, true));
  } catch (error) {
    console.log('No platform component tokens for ' + platform);
  }
  if (includeMobileTokens) {
    try {
      merge(tokenData, loadFile('platformcomponents/mobile', true));
    } catch (error) {
      console.log('No platform component tokens for mobile');
    }
  }
  if (includeDesktopTokens) {
    try {
      merge(tokenData, loadFile('platformcomponents/desktop', true));
    } catch (error) {
      console.log('No platform component tokens for desktop');
    }
  }

  themeFile.files.forEach((fileName) => {
    if (fileName.endsWith('/')) {
      merge(tokenData, loadFile(fileName.slice(0, -1), true));
    } else {
      merge(tokenData, loadFile(fileName, false));
    }
  });
  /*console.log('=== After load theme data =====================');
  console.log(JSON.stringify(tokenData, null, 2));*/
  
  // Resolve all the references
  tokenData = resolveValue(tokenData, tokenData, coreTokens, flattenedCoreTokens);
  /*console.log('=== After resolve references ==================');
  console.log(JSON.stringify(tokenData, null, 2));*/
  
  if (omitThemeTokens) {
    delete tokenData.theme;
  }

  // Flatten the token names and then expand every token into UI states
  let stateTokens = {};
  if (componentGroups) {
    const flattenedTokens = {};
    Object.entries(tokenData).forEach(([key, value]) => {
      const categoryFlattenedTokens = {};
      flattenObject('', value, categoryFlattenedTokens);
      stateTokens[key] = finaliseTokens(categoryFlattenedTokens);
    });
    
  } else {
    const flattenedTokens = {};
    flattenObject('', tokenData, flattenedTokens);
    stateTokens = finaliseTokens(flattenedTokens);
  }
  /*console.log('=== After flattening tokens ===================');
  console.log(JSON.stringify(flattenedTokens, null, 2));*/
  
  // Output the flattened file

  fs.mkdir('dist', (err) => {});
  let outputFileName = '';
  if (fileFormat === 'css') {
    indexFileData.push(`@import '${camelCase(themeFile.name)}.css';`);
    outputFileName = path.join('dist', camelCase(themeFile.name) + '.css');
    let fileHandle = undefined;
    if (!toStdOut) {
      fileHandle = fs.openSync(outputFileName, 'w');
    }
    function outputLine(line) {
      if (toStdOut) {
        console.log(line);
      } else {
        fs.writeSync(fileHandle, line+'\n');
      }
    }
    outputLine('.md-theme-' + camelCase(themeFile.name) + ' {');
    Object.entries(stateTokens).forEach(([key, value]) => {
      outputLine('  --'+key+': '+value+';');
    });
    outputLine('}');
  } else if (fileFormat === 'json') {
    outputFileName = path.join('dist', camelCase(themeFile.name) + '.json');
    if (toStdOut) {
      console.log(stateTokens);
    } else {
      fs.writeFile(outputFileName, JSON.stringify(stateTokens, null, 2), 'utf8', function (err) {
        if (err) 
        {
          console.log("Error when writing JSON file: " + err);
          process.exit(1);
        }
      });
    }
  }
  if (!toStdOut) {
    console.log(`Written to ${outputFileName}`);
  }
  console.log('=== Theme processed ======================');
});

if (platform === 'web') {
  const indexFileContent = indexFileData.join('\n');
  const indexFileName = path.join('dist', 'index.css');

  fs.writeFileSync(indexFileName, indexFileContent, 'utf8');
}
