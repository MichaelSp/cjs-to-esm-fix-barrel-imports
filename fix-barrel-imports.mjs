import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import console from 'node:console';
import { globbySync } from 'globby';

const barrelFiles = new Set();
const currentDirectory = process.cwd();
const workingPath = `${currentDirectory}/client/src`;
const globPattern = `${workingPath}/**/*.ts`;

function detectExtensionForFile(currentDirectory, destination) {
    const destinations = [destination, destination.replace('.js', '.ts'), `${destination}.ts`, `${destination}.js`];
    // check if the file exists in the directory
    const dest = destinations.find((destination) => {
        const absolutePath = path.join(currentDirectory, destination);
        // absolutePath exists and is a file
        return fs.existsSync(absolutePath) && fs.statSync(absolutePath).isFile();
    });
    return dest;
}

function importsToSymbolsArray(imports) {
    const symbols = imports
        .split(',')
        .map((symbol) => symbol.trim())
        .filter((symbol) => symbol !== '*')
        .filter((symbol) => symbol !== '{' && symbol !== '}')
        .filter((symbol) => symbol !== '');
    if (symbols.length === 0) {
        return [];
    }
    return symbols;
}

// read the file content and try to find the symbols from the imports
function findSymbolsInFile(realFile, imports) {
    const fileContent = fs.readFileSync(realFile, 'utf8');
    const symbols = importsToSymbolsArray(imports);

    return symbols.filter((symbol) =>
        fileContent.match(new RegExp(`(class|type|enum|const|let|var|interface)\\s+${symbol}[\\s<]`))
    );
}

function findImportsInBarrel(currentDirectory, filePath, importStatement, imports, destination) {
    const barrelPath = path.join(currentDirectory, destination, 'index.ts');
    if (fs.existsSync(barrelPath) && fs.statSync(barrelPath).isFile()) {
        barrelFiles.add(barrelPath);
        // loop through the barrel file and find the import
        const barrelFile = fs.readFileSync(barrelPath, 'utf8');
        const barrelExports = barrelFile.match(/export.*?from\s+'(\..*?)';/g);
        const newImports = [];
        for (const barrelExport of barrelExports) {
            const exports = barrelExport.match(/export.*?from\s+'(\..*?)';/);
            if (exports[1] === './') {
                continue;
            }
            const exportFile = path.join(destination, exports[1]);

            const exportFileWithExtension = detectExtensionForFile(currentDirectory, exportFile);
            // check if file exists
            if (!exportFileWithExtension) {
                // check if that is a folder that contains a barrel file
                const barrelPath = path.join(currentDirectory, exportFile, 'index.ts');
                if (fs.existsSync(barrelPath) && fs.statSync(barrelPath).isFile()) {
                    const importsInBarrel = findImportsInBarrel(
                        currentDirectory,
                        filePath,
                        importStatement,
                        imports,
                        exportFile
                    );
                    newImports.push(importsInBarrel);
                    continue;
                } else {
                    console.warn("The file doesn't exist in ", exportFile);
                    continue;
                }
            }
            const realFile = path.join(currentDirectory, exportFileWithExtension);

            if (realFile) {
                const foundSymbols = findSymbolsInFile(realFile, imports);
                if (foundSymbols.length > 0 && foundSymbols !== ['']) {
                    const newImportDestination = exportFileWithExtension.replace(/\.ts$/, '.js');
                    if (!newImportDestination.includes('.js') && !newImportDestination.includes('.ts')) {
                        console.warn(`${filePath}: The file doesn't have an extension ${newImportDestination}`);
                    }
                    newImports.push(`import { ${foundSymbols.join(', ')} } from './${newImportDestination}';`);

                    // remove the found symbols from the imports
                    const sym = importsToSymbolsArray(imports);
                    sym.filter((symbol) => !foundSymbols.includes(symbol));
                    imports = sym.join(', ');
                }
            }
        }
        if (newImports.length > 0) {
            return newImports.join('\n');
        }
        console.warn(
            `${filePath}: Couldn't find the import '${imports}' in the barrel file "${barrelPath}" for this import statement "${importStatement}"`
        );
    } else {
        console.warn(`${filePath}: Neither the file nor the barrel file exists -> ${importStatement}`);
    }
}

// find the import statement in the file and returns the new import statement
async function fixImportStatement(currentDirectory, filePath, importStatement) {
    // extract the path from the import statement
    const data = /import\s+(type\s+)?({?\s*[\S\s]+\s+}\s+|(?:.\*\s+as\s+)?[\S\s]+)from\s+'(\.[^']+)';/g.exec(
        importStatement
    );
    if (!data || data.length !== 4) {
        console.error(`${filePath} something is fishy with the import statement`, importStatement, data);
        return false;
    }
    const typeImport = data[1];
    const imports = data[2].replaceAll(/[{}]/g, '').trim();
    const destination = data[3];

    if (imports.includes('import')) {
        console.error(`${filePath} something is fishy with the import statement`, importStatement, data);
        return false;
    }
    const dest = detectExtensionForFile(currentDirectory, destination);
    if (dest) {
        const imp = importStatement.match(/import[\s\n]+{/) ? `{ ${imports} }` : imports;
        return `import ${typeImport || ''}${imp} from '${dest.replace(/\.ts$/, '.js')}';`;
    } else {
        // check if there is a barrel file in the directory
        return findImportsInBarrel(currentDirectory, filePath, importStatement, imports, destination);
    }
}

async function transformImports(filePath) {
    const currentDirectory = path.dirname(filePath);
    let data = fs.readFileSync(filePath, 'utf8');

    // find all the import statements that match the regex import.*?from\s+'\..*?';
    // in the given file and loop over all occurrences
    const importStatements = data.match(/import[\s\S]+?from\s+'.*?';/g);
    if (!importStatements) {
        console.log(`${filePath} No import statements found`);
        return;
    }
    for (const importStatement of importStatements) {
        if (!importStatement.includes("'.")) {
            continue; // skip the import statements that not relative
        }
        const newImportStatement = await fixImportStatement(currentDirectory, filePath, importStatement);
        // console.log(filePath, importStatement, newImportStatement);
        if (newImportStatement) {
            data = data.replace(importStatement, newImportStatement);
        }
    }

    // write the updated data back to the file
    console.log(`${filePath} Updated file`);
    fs.writeFileSync(filePath, data, 'utf8');
}

await Promise.all(
    globbySync(globPattern).map(async (filePath) => {
        await transformImports(filePath);
    })
);

// if barrel exists in workingPath, the add it to barrelFiles
const barrelPath = path.join(workingPath, 'index.ts');
if (fs.existsSync(barrelPath) && fs.statSync(barrelPath).isFile()) {
    barrelFiles.add(barrelPath);
}

// delete the barrel files
for (const barrelFile of barrelFiles) {
    console.log('deleting barrel file', barrelFile);
    fs.unlinkSync(barrelFile);
}
