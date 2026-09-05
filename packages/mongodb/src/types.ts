import type { Document } from "mongodb"

export interface MongoCursor<T = Document> {
  toArray(): Promise<T[]>
}

export interface MongoCollection {
  aggregate(pipeline: Document[], options?: Document): MongoCursor<Document>
}

export interface MongoCollectionInfo {
  name: string
  type?: string
  options?: {
    validator?: Document
  }
}

export interface MongoDatabase {
  listCollections(filter?: Document, options?: Document): MongoCursor<MongoCollectionInfo>
  collection(name: string): MongoCollection
}
