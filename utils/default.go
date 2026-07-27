package utils

import (
	"fmt"
	"reflect"
	"strconv"
)

func ApplyDefaultValues(struct_ interface{}) (err error) {
	fields, err := structFields(struct_)
	if err != nil {
		return err
	}

	for _, field := range fields {
		defaultValue := field.Tag("default")
		if defaultValue == "" {
			continue
		}
		var val interface{}
		switch field.Kind() {
		case reflect.String:
			val = defaultValue
		case reflect.Bool:
			if defaultValue == "true" {
				val = true
			} else if defaultValue == "false" {
				val = false
			} else {
				return fmt.Errorf("invalid bool expression: %v, use true/false", defaultValue)
			}
		case reflect.Int:
			val, err = strconv.Atoi(defaultValue)
			if err != nil {
				return err
			}
		default:
			val = field.Value()
		}
		field.Set(val)
	}
	return nil
}
