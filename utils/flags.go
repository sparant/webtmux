package utils

import (
	"reflect"
	"strings"

	"github.com/urfave/cli/v3"
)

func GenerateFlags(options ...interface{}) (flags []cli.Flag, mappings map[string]string, err error) {
	mappings = make(map[string]string)

	for _, struct_ := range options {
		fields, err := structFields(struct_)
		if err != nil {
			return nil, nil, err
		}
		for _, field := range fields {
			flagName := field.Tag("flagName")
			if flagName == "" {
				continue
			}
			envName := "GOTTY_" + strings.ToUpper(strings.Join(strings.Split(flagName, "-"), "_"))
			mappings[flagName] = field.Name()

			flagShortName := field.Tag("flagSName")
			var aliases []string
			if flagShortName != "" {
				aliases = []string{flagShortName}
			}

			flagDescription := field.Tag("flagDescribe")

			switch field.Kind() {
			case reflect.String:
				flags = append(flags, &cli.StringFlag{
					Name:    flagName,
					Value:   field.Value().(string),
					Usage:   flagDescription,
					Sources: cli.EnvVars(envName),
					Aliases: aliases,
				})
			case reflect.Bool:
				flags = append(flags, &cli.BoolFlag{
					Name:        flagName,
					Usage:       flagDescription,
					Sources:     cli.EnvVars(envName),
					Aliases:     aliases,
					DefaultText: field.Tag("default"),
				})
			case reflect.Int:
				flags = append(flags, &cli.IntFlag{
					Name:    flagName,
					Value:   field.Value().(int),
					Usage:   flagDescription,
					Sources: cli.EnvVars(envName),
					Aliases: aliases,
				})
			}
		}
	}

	return
}

func ApplyFlags(
	flags []cli.Flag,
	mappingHint map[string]string,
	cmd *cli.Command,
	options ...interface{},
) error {
	fields, err := fieldsByName(options...)
	if err != nil {
		return err
	}

	for flagName, fieldName := range mappingHint {
		if !cmd.IsSet(flagName) {
			continue
		}
		field, ok := fields[fieldName]
		if !ok {
			continue
		}
		var val interface{}
		switch field.Kind() {
		case reflect.String:
			val = cmd.String(flagName)
		case reflect.Bool:
			val = cmd.Bool(flagName)
		case reflect.Int:
			val = cmd.Int(flagName)
		default:
			// GenerateFlags records the mapping before it knows the kind, so a
			// tagged field of some other type reaches here with no flag behind
			// it. Setting from a nil value would panic.
			continue
		}
		field.Set(val)
	}
	return nil
}
