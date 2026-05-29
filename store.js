const { app } = require("./index")
const fs = require("fs")
const path = require("path")
 
module.exports = class DataStore {

    id = ""

    /**
     * Creates a new store instance with the given id. The store will be in the user's data directory under the "stores" folder.
     * @param {string} id
     */
    constructor(id) {

        if(!id) throw new Error("Store id is required")
        if (id.includes("/") || id.includes("\\") || id === ".." || id === ".") {
            throw new Error("Invalid store id: cannot contain path traversals")
        }

        this.id = id

        this.path = path.join(app.userData.getPath(), "stores", `${id}.json`)

        if(!fs.existsSync(path.join(app.userData.getPath(), "stores"))) {
            fs.mkdirSync(path.join(app.userData.getPath(), "stores"), { recursive: true })
        }

        if (!fs.existsSync(this.path)) {
            fs.writeFileSync(this.path, JSON.stringify({}))
        }

    }

    /**
     * Gets the value of the given key from the store. If the key does not exist, it will return undefined.
     * @param {string} key 
     * @returns {any} Value of the key
     */
    get(key) {
        const data = JSON.parse(fs.readFileSync(this.path))
        return data[key]
    }

    /**
     * Sets the value of the given key in the store.
     * @param {string} key 
     * @param {any} value 
     */
    set(key, value) {
        const data = JSON.parse(fs.readFileSync(this.path))
        data[key] = value
        fs.writeFileSync(this.path, JSON.stringify(data))
    }

    /**
     * Deletes the given key from the store.
     * @param {string} key The key to delete 
     */
    delete(key) {
        const data = JSON.parse(fs.readFileSync(this.path))
        delete data[key]
        fs.writeFileSync(this.path, JSON.stringify(data))
    }

    /**
     * Clears all keys from the store.
     */
    clear() {
        fs.writeFileSync(this.path, JSON.stringify({}))
    }

    /**
     * Deletes the store file from the user's data directory.
     */
    rm() {
        fs.rmSync(this.path)
    }

    /**
     * Creates the store file if it does not exist. If the file already exists, it does nothing.
     */
    create() {
        if (!fs.existsSync(this.path)) {
            fs.writeFileSync(this.path, JSON.stringify({}))
        }
    }

    /**
     * Checks if the store file exists in the user's data directory.
     * @returns {boolean} True if the store file exists, false otherwise.
     */
    exists() {
        return fs.existsSync(this.path)
    }

    /**
     * Gets all keys and values from the store as an object.
     * @returns {object} An object containing all keys and values from the store.
     */
    all() {
        return JSON.parse(fs.readFileSync(this.path))
    }

}